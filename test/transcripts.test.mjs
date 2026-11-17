import './sandbox-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, appendFileSync, renameSync, truncateSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { USAGE_COUNTERS } from '../lib/usage.mjs';

// Captured 2026-11-15: codex/claude runtime homes; Copilot/OpenCode turn-3
// snapshots; Antigravity scrubbed final and streaming stores. JSONL strings
// over 2000 characters are trimmed and run roots become /tmp/fixture. Ordered
// parts preserve every record while keeping each fixture file below 40 KB.
const root = new URL('./fixtures/transcripts/', import.meta.url);
const companions = ['codex', 'claude', 'copilot', 'opencode', 'antigravity'];
const sessions = { opencode: 'ses_e229ce437ffeBST2EZW9xCg9Wa', antigravity: '1a918eda-5640-4eb3-b905-e322fadbadce' };
const api = () => import('../lib/transcripts.mjs');
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'transcripts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function jsonl(companion, failure = false) {
  const dir = new URL(`${companion}/`, root);
  return readdirSync(dir).filter(n => n.startsWith(failure ? 'failure' : 'transcript')).sort()
    .map(n => readFileSync(new URL(n, dir))).reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0));
}
function fixture(t, companion, { streaming = false, failure = false } = {}) {
  const path = join(temp(t), 'transcript');
  const kind = ['opencode', 'antigravity'].includes(companion) ? 'sqlite' : 'jsonl';
  if (kind === 'jsonl') writeFileSync(path, jsonl(companion, failure));
  else {
    const db = new DatabaseSync(path);
    db.exec(readFileSync(new URL(`${companion}/${companion === 'opencode' ? 'opencode' : streaming ? 'fixture-streaming' : 'fixture'}.sql`, root), 'utf8'));
    db.close();
  }
  return { companion, kind, path, sessionId: sessions[companion] ?? companion };
}

for (const companion of companions) {
  test(`${companion}: captured commands, edits, replies, usage and native turns`, async t => {
    const { readTranscript } = await api();
    const loc = fixture(t, companion);
    const result = readTranscript(loc);
    assert.equal(result.format.recognized, true, result.format.detail);
    assert.notEqual(result.format.version, null);
    assert.equal(result.counts.unrecognized, 0);
    const { items } = result;
    assert.equal(new Set(items.map(i => i.id)).size, items.length);
    for (const [command, code] of [['echo FIXTURE-OK', 0], ['ls /nonexistent-fixture-path', 1]]) {
      assert.ok(items.some(i => i.kind === 'command' && (Array.isArray(i.command) ? i.command.includes(command) : i.command === command) && i.exitCode === code), `${command}: exit ${code}`);
    }
    for (const change of ['add', 'update']) assert.ok(items.some(i => i.kind === 'edit' && i.paths.some(p => p.path.endsWith('notes.txt') && p.change === change)), change);
    assert.ok(items.some(i => i.kind === 'assistant' && /DONE/.test(i.text)));
    const user = items.find(i => i.kind === 'user' && /echo FIXTURE-OK/.test(i.text));
    assert.ok(user);
    if (['codex', 'claude', 'opencode'].includes(companion)) {
      assert.ok(user.turnId);
      assert.ok(items.some(i => i.kind === 'command' && i.turnId === user.turnId));
      if (companion === 'claude') assert.equal(user.turnId, '45a9a594-62ac-435f-9ebb-f34f6d395802');
      if (companion === 'opencode') assert.equal(user.turnId, 'msg_1dd631d06001TjpGP77MX3LCPs');
    } else if (companion === 'antigravity') assert.ok(items.every(i => i.turnId === null));
    const usage = items.filter(i => i.kind === 'usage');
    if (companion === 'antigravity') assert.equal(usage.length, 0);
    else {
      assert.ok(usage.length);
      for (const i of usage) for (const key of USAGE_COUNTERS) assert.ok(Object.hasOwn(i.usage, key), key);
      assert.ok(usage.some(i => i.usage.input_tokens > 0 && i.usage.output_tokens > 0));
    }
    assert.deepEqual(readTranscript(loc, { after: result.cursor }).items, []);
  });
  test(`${companion}: unknown native type is visible and counted`, async t => {
    const { readTranscript } = await api();
    const loc = fixture(t, companion);
    const before = readTranscript(loc);
    if (loc.kind === 'jsonl') appendFileSync(loc.path, JSON.stringify({ type: 'future.record', id: 'unknown', data: {}, payload: {} }) + '\n');
    else {
      const db = new DatabaseSync(loc.path);
      if (companion === 'opencode') db.prepare('INSERT INTO session_message VALUES(?,?,?,?,?,?,?)').run('unknown', loc.sessionId, 'future.record', 999, 1, 1, '{}');
      else db.exec('INSERT INTO steps(idx,step_type,status,step_payload) VALUES(999,999,3,X\'\')');
      db.close();
    }
    const result = readTranscript(loc, { after: before.cursor });
    assert.equal(result.counts.unrecognized, 1);
    assert.equal(result.items.filter(i => i.kind === 'unrecognized').length, 1);
  });
}
for (const companion of ['codex', 'claude', 'copilot', 'opencode']) {
  test(`${companion}: captured provider failure`, async t => {
    const { readTranscript } = await api();
    const result = readTranscript(fixture(t, companion, { failure: companion === 'copilot' }));
    assert.equal(result.counts.unrecognized, 0);
    const error = result.items.find(i => i.kind === 'error');
    assert.ok(error);
    assert.equal(error.status, 'failed');
    assert.ok(error.error.type);
    assert.match(error.error.message, companion === 'opencode' ? /Model unavailable/ : /429/);
    if (companion === 'claude' || companion === 'copilot') assert.equal(error.error.type, 'rate_limit');
    if (companion === 'opencode') assert.equal(error.error.type, 'provider.no-route');
  });
}
for (const companion of ['codex', 'claude', 'copilot']) {
  test(`${companion}: byte cursor ignores partial lines and preserves cross-read context`, async t => {
    const { readTranscript } = await api();
    const loc = fixture(t, companion);
    const bytes = readFileSync(loc.path);
    const expected = readTranscript(loc);
    const split = Math.floor(bytes.length / 2);
    writeFileSync(loc.path, bytes.subarray(0, split));
    const first = readTranscript(loc);
    assert.equal(first.cursor, bytes.lastIndexOf(10, split - 1) + 1);
    appendFileSync(loc.path, bytes.subarray(split));
    const second = readTranscript(loc, { after: first.cursor });
    const merged = new Map([...first.items, ...second.items].map(i => [i.id, i]));
    assert.deepEqual([...merged.values()], expected.items);
    assert.equal(second.cursor, bytes.length);
    assert.deepEqual(readTranscript(loc, { after: second.cursor }).items, []);
  });
}
for (const companion of ['codex', 'claude', 'copilot']) {
  test(`${companion}: follow keeps the parse state and matches cursor reads at every append`, async t => {
    const { readTranscript, followTranscript } = await api();
    const dir = new URL(`${companion}/`, root);
    const bytes = Buffer.concat(readdirSync(dir).sort().map(n => readFileSync(new URL(n, dir))));
    const loc = { companion, kind: 'jsonl', path: join(temp(t), 'transcript'), sessionId: companion };
    writeFileSync(loc.path, '');
    const follow = followTranscript(loc);
    const merged = new Map();
    let cursor = 0;
    // Uneven chunks split lines mid-record, as a live writer does.
    for (let at = 0, step = 1; at < bytes.length; at += step, step = step * 3 % 997 + 1) {
      appendFileSync(loc.path, bytes.subarray(at, at + step));
      const expected = readTranscript(loc, { after: cursor });
      const got = follow.read();
      assert.equal(got.reset, false);
      assert.equal(got.cursor, expected.cursor);
      assert.deepEqual(got.items, expected.items);
      assert.deepEqual(got.format, expected.format);
      cursor = got.cursor;
      for (const item of got.items) merged.set(item.id, item);
    }
    assert.deepEqual([...merged.values()], readTranscript(loc).items);
  });
}
test('follow reads only appended bytes and restarts on a replaced or shrunk file', async t => {
  const { readTranscript, followTranscript } = await api();
  const loc = { companion: 'codex', kind: 'jsonl', path: join(temp(t), 'transcript'), sessionId: 'codex' };
  const bytes = jsonl('codex');
  const half = bytes.lastIndexOf(10, bytes.length / 2) + 1;
  writeFileSync(loc.path, bytes.subarray(0, half));
  const follow = followTranscript(loc);
  assert.ok(follow.read().items.length);
  const intact = { ...loc, path: loc.path + '.intact' };
  writeFileSync(intact.path, bytes);
  const expected = readTranscript(intact, { after: half }).items;
  // Blank the bytes already read, in place, then append: a replaying read loses
  // the session and turn context; follow never reads those bytes again.
  const damaged = Buffer.concat([Buffer.alloc(half, ' '), bytes.subarray(half)]);
  damaged[half - 1] = 10;
  writeFileSync(loc.path, damaged, { flag: 'r+' });
  assert.notDeepEqual(readTranscript(loc, { after: half }).items, expected);
  assert.deepEqual(follow.read().items, expected);
  renameSync(intact.path, loc.path);
  const replaced = follow.read();
  assert.equal(replaced.reset, true);
  assert.deepEqual(replaced.items, readTranscript(loc).items);
  truncateSync(loc.path, half);
  assert.equal(follow.read().reset, true);
});
test('antigravity: streaming step 9 is upserted when finalized', async t => {
  const { readTranscript } = await api();
  const first = readTranscript(fixture(t, 'antigravity', { streaming: true }));
  assert.equal(first.format.recognized, true, first.format.detail);
  assert.equal(first.counts.unrecognized, 0);
  const streaming = first.items.find(i => i.status === 'streaming');
  assert.ok(streaming);
  assert.match(streaming.id, /9$/);
  const next = readTranscript(fixture(t, 'antigravity'), { after: first.cursor });
  const final = next.items.find(i => i.id === streaming.id);
  assert.equal(final.status, 'completed');
  assert.match(final.text, /DONE/);
});
test('opencode: same-timestamp in-place update and session isolation', async t => {
  const { readTranscript } = await api();
  const loc = fixture(t, 'opencode');
  const first = readTranscript(loc);
  const db = new DatabaseSync(loc.path);
  const row = db.prepare("SELECT * FROM session_message WHERE type='assistant' ORDER BY seq LIMIT 1").get();
  const data = JSON.parse(row.data); data.content[0].text = 'changed in place';
  db.prepare('UPDATE session_message SET data=? WHERE id=?').run(JSON.stringify(data), row.id);
  db.close();
  const next = readTranscript(loc, { after: first.cursor });
  const item = next.items.find(i => i.text === 'changed in place');
  assert.ok(item);
  assert.ok(first.items.some(i => i.id === item.id));
  assert.deepEqual(readTranscript({ ...loc, sessionId: 'missing' }).items, []);
});
test('locators: defaults, overrides, Codex preference, Claude project scan, missing', async t => {
  const { locateTranscript } = await api();
  const home = temp(t);
  const defaults = { codex: '.codex/sessions/2026/11/15/rollout-date-session.jsonl', claude: '.claude/projects/project/session.jsonl', copilot: '.copilot/session-state/session/events.jsonl', opencode: '.local/share/opencode/opencode.db', antigravity: '.gemini/antigravity-acp/conversations/session.db' };
  const keys = { codex: 'CODEX_HOME', claude: 'CLAUDE_CONFIG_DIR', copilot: 'COPILOT_HOME', opencode: 'XDG_DATA_HOME', antigravity: 'GEMINI_HOME' };
  for (const companion of companions) {
    assert.equal(locateTranscript({ companion, historyId: 'session', env: { HOME: home } }), null);
    const path = join(home, defaults[companion]); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, '');
    assert.deepEqual(locateTranscript({ companion, historyId: 'session', env: { HOME: home } }), { companion, kind: ['opencode', 'antigravity'].includes(companion) ? 'sqlite' : 'jsonl', path, sessionId: 'session' });
    const relative = defaults[companion].replace(companion === 'opencode' ? '.local/share/' : /^[^/]+\//, '');
    const override = join(home, companion, relative); mkdirSync(dirname(override), { recursive: true }); writeFileSync(override, '');
    assert.equal(locateTranscript({ companion, historyId: 'session', env: { HOME: home, [keys[companion]]: join(home, companion) } }).path, override);
  }
  const explicit = join(home, 'explicit'); writeFileSync(explicit, '');
  assert.equal(locateTranscript({ companion: 'codex', historyId: 'session', nativeRefs: { transcriptPath: explicit }, env: { HOME: home } }).path, explicit);
  assert.equal(locateTranscript({ companion: 'opencode', historyId: 'session', env: { HOME: home, OPENCODE_DB: explicit } }).path, explicit);
});
test('unreadable or malformed stores return a visible format reason', async t => {
  const { readTranscript } = await api();
  for (const companion of companions) {
    const loc = fixture(t, companion); rmSync(loc.path);
    const result = readTranscript(loc);
    assert.equal(result.format.recognized, false); assert.ok(result.format.detail);
    writeFileSync(loc.path, 'not a transcript\n');
    assert.equal(readTranscript(loc).format.recognized, false);
  }
});

for (const companion of companions) {
  test(`${companion}: newer fingerprint is reported without gating and reads write nothing`, async t => {
    const { readTranscript } = await api();
    const loc = fixture(t, companion);
    if (loc.kind === 'jsonl') {
      const records = readFileSync(loc.path, 'utf8').trimEnd().split('\n').map(JSON.parse);
      for (const r of records) {
        if (companion === 'codex' && r.type === 'session_meta') r.payload.cli_version = '999.0';
        if (companion === 'claude' && r.version) r.version = '999.0';
        if (companion === 'copilot' && r.type === 'session.start') { r.data.version = 999; r.data.copilotVersion = '999.0'; }
      }
      writeFileSync(loc.path, records.map(r => JSON.stringify(r) + '\n').join(''));
    } else {
      const db = new DatabaseSync(loc.path);
      db.exec(companion === 'opencode' ? "INSERT INTO migration VALUES('999_future',1)" : 'UPDATE steps SET step_format=999'); db.close();
    }
    const bytes = readFileSync(loc.path), files = readdirSync(dirname(loc.path));
    const result = readTranscript(loc);
    assert.equal(result.format.recognized, true, result.format.detail);
    assert.match(JSON.stringify(result.format.version), /999/);
    assert.deepEqual(readFileSync(loc.path), bytes);
    assert.deepEqual(readdirSync(dirname(loc.path)), files);
  });
}
test('command output cap is bytes, preserves UTF-8, and marks truncation', async t => {
  const { readTranscript } = await api();
  const loc = fixture(t, 'codex');
  const output = '😀'.repeat(20000);
  appendFileSync(loc.path, JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', turn_id: 'cap-turn', item: { type: 'CommandExecution', id: 'cap', command: ['echo', 'large'], status: 'completed', aggregated_output: output } } }) + '\n');
  const command = readTranscript(loc).items.find(i => i.id.endsWith(':cap'));
  assert.equal(Buffer.byteLength(command.output), 65536);
  assert.equal(command.truncated, true);
  assert.ok(!command.output.includes('�'));
  assert.equal(command.exitCode, null);
});
test('Claude command exit code stays unknown without native success or a failure code', async t => {
  const { readTranscript } = await api();
  const loc = fixture(t, 'claude');
  const base = { sessionId: 'fixture', version: '999', cwd: '/tmp/fixture' };
  const records = [
    { ...base, type: 'user', uuid: 'prompt', message: { content: 'run command' } },
    ...[undefined, false, true, true].flatMap((is_error, n) => [
      { ...base, type: 'assistant', uuid: `call-${n}`, message: { content: [{ type: 'tool_use', id: `tool-${n}`, name: 'Bash', input: { command: 'something' } }] } },
      { ...base, type: 'user', uuid: `result-${n}`, message: { content: [{ type: 'tool_result', tool_use_id: `tool-${n}`, content: n === 3 ? 'Exit code 7\nfailure' : 'interrupted', is_error }] } },
    ]),
  ];
  writeFileSync(loc.path, records.map(r => JSON.stringify(r) + '\n').join(''));
  const commands = readTranscript(loc).items.filter(i => i.kind === 'command');
  assert.deepEqual(commands.map(i => i.exitCode), [null, 0, null, 7]);
  assert.ok(commands.every(i => i.turnId === 'prompt'));
});
test('unknown nested content is not silently dropped', async t => {
  const { readTranscript } = await api();
  for (const companion of ['codex', 'claude', 'opencode']) {
    const loc = fixture(t, companion), first = readTranscript(loc);
    if (companion === 'opencode') {
      const db = new DatabaseSync(loc.path);
      db.prepare('INSERT INTO session_message VALUES(?,?,?,?,?,?,?)').run('future', loc.sessionId, 'assistant', 1000, 1, 1, JSON.stringify({ content: [{ type: 'future.part' }] })); db.close();
    } else appendFileSync(loc.path, JSON.stringify(companion === 'codex'
      ? { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FutureItem' } } }
      : { type: 'assistant', message: { content: [{ type: 'future.part' }] } }) + '\n');
    assert.equal(readTranscript(loc, { after: first.cursor }).counts.unrecognized, 1);
  }
});
test('protobuf decoder preserves repeated fields and rejects truncated wire data', async () => {
  const { decode, field } = await import('../lib/transcripts/protobuf.mjs');
  assert.deepEqual(decode(Buffer.from([8, 1, 8, 2])).get(1).map(f => f.value), [1n, 2n]);
  assert.equal(field(Buffer.from([18, 2, 8, 7]), 2, 1), 7n);
  for (const bytes of [[8, 128], [18, 3, 1], [0], [11]]) assert.throws(() => decode(Buffer.from(bytes)));
});

test('every item timestamp is an ISO string or null, whatever the native clock format', async t => {
  const { readTranscript } = await api();
  for (const loc of companions.map(companion => fixture(t, companion))) {
    for (const item of readTranscript(loc).items) {
      assert.ok(item.at === null || (typeof item.at === 'string' && !Number.isNaN(Date.parse(item.at)) && item.at.endsWith('Z')), `${loc.companion} ${item.nativeType}: ${item.at}`);
    }
  }
});

// Placeholder-only records modeled on real-shapes/shapes.json. Never open the
// operator's native stores: the reviewed shapes are the entire evidence here.
function shapeFixture(t, companion, file = 'additional-shapes.jsonl') {
  const path = join(temp(t), 'shapes.jsonl');
  writeFileSync(path, readFileSync(new URL(`${companion}/${file}`, root)));
  return { companion, kind: 'jsonl', path, sessionId: 'shapes' };
}
for (const companion of ['codex', 'claude', 'copilot']) {
  test(`${companion}: additional observed shapes have deliberate mappings`, async t => {
    const { readTranscript } = await api();
    const loc = shapeFixture(t, companion);
    const result = readTranscript(loc);
    assert.equal(result.counts.unrecognized, 0, JSON.stringify(result.items.filter(i => i.kind === 'unrecognized').map(i => i.nativeType)));
    assert.equal(result.format.recognized, true, result.format.detail);
    if (companion === 'codex') {
      assert.deepEqual(result.items.map(i => i.kind), ['tool', 'tool', 'tool', 'tool', 'tool', 'preamble', 'preamble', 'tool']);
      // Extension is a generic container: kind names the extension tool.
      const sleep = result.items.find(i => i.name === 'clock.sleep');
      assert.equal(sleep.durationMs, 45000); assert.equal(sleep.status, 'completed');
      const custom = result.items[0];
      assert.equal(custom.name, 'exec'); assert.equal(custom.input, 'text("fixture result")');
      assert.equal(custom.output, 'fixture result'); assert.equal(custom.turnId, 'shape-turn');
      assert.equal(custom.status, 'completed');
      const searches = result.items.filter(i => i.name === 'web.search');
      assert.deepEqual(searches.map(i => i.query), ['fixture query 0', 'fixture query 1', 'fixture query 2']);
      assert.deepEqual(searches.map(i => i.action.type), ['search', 'openPage', 'search']);
      assert.ok(searches.every(i => i.results.length));
      assert.equal(result.items.find(i => i.name === 'ImageView').path, '/tmp/fixture/image.png');
      const compacted = result.items.find(i => i.nativeType === 'compacted');
      assert.equal(compacted.replacementHistory[0].content[0].text, 'replacement context');
      assert.match(compacted.text, /replacement context/);
      assert.ok(result.items.some(i => i.nativeType.endsWith('/ContextCompaction')));
    } else if (companion === 'claude') {
      assert.deepEqual(result.items, [], 'sampled system subtypes are timing and recap bookkeeping');
    } else {
      assert.deepEqual(result.items.map(i => i.kind), ['preamble', 'preamble', 'preamble', 'assistant', 'tool', 'user', 'tool', 'tool']);
      assert.equal(result.items.filter(i => i.kind === 'assistant').length, 1, 'model response updates its matching model message');
      assert.equal(result.items.find(i => i.kind === 'assistant').text, 'model-only assistant text');
      assert.equal(result.items.find(i => i.nativeType === 'session.compaction_complete').text, 'compacted context');
      assert.equal(result.items.find(i => i.nativeType === 'subagent.completed').status, 'completed');
      assert.equal(result.items.find(i => i.kind === 'user').text, 'fixture human response');
      assert.equal(result.items.find(i => i.name === 'shell_completed').status, 'completed');
      assert.equal(result.items.find(i => i.name === 'agent_idle').status, null, 'idle does not prove completion');
      assert.ok(result.items.every(i => i.turnId === null), 'model-call numbers are not prompt turn IDs');
    }
    assert.deepEqual(readTranscript(loc, { after: result.cursor }).items, []);
  });
}
test('Codex custom tool output upserts the call across reads without replaying commands', async t => {
  const { readTranscript } = await api();
  const loc = shapeFixture(t, 'codex');
  const lines = readFileSync(loc.path, 'utf8').trimEnd().split('\n');
  const outputIndex = lines.findIndex(l => JSON.parse(l).payload?.type === 'custom_tool_call_output');
  writeFileSync(loc.path, lines.slice(0, outputIndex).join('\n') + '\n');
  const first = readTranscript(loc);
  const call = first.items.find(i => i.kind === 'tool');
  assert.ok(call);
  appendFileSync(loc.path, lines[outputIndex] + '\n');
  const next = readTranscript(loc, { after: first.cursor });
  assert.equal(next.counts.unrecognized, 0);
  assert.equal(next.items.length, 1); assert.equal(next.items[0].id, call.id);
  assert.equal(next.items[0].input, call.input); assert.equal(next.items[0].output, 'fixture result');
  const nativeCommand = { type: 'event_msg', payload: { type: 'item_completed', turn_id: 'shape-turn', item: { type: 'CommandExecution', id: 'inner-command', command: ['echo', 'fixture'], exit_code: 0, aggregated_output: 'fixture' } } };
  appendFileSync(loc.path, JSON.stringify(nativeCommand) + '\n');
  const end = readTranscript(loc, { after: next.cursor });
  assert.deepEqual(end.items.map(i => i.kind), ['command']);
});
test('Copilot model text is retained without assuming duplication with assistant.message', async t => {
  const { readTranscript } = await api();
  const loc = shapeFixture(t, 'copilot');
  const first = readTranscript(loc), model = first.items.find(i => i.kind === 'assistant');
  appendFileSync(loc.path, JSON.stringify({ type: 'assistant.message', id: 'assistant-native', data: { content: 'separate assistant message' } }) + '\n');
  const next = readTranscript(loc, { after: first.cursor });
  assert.equal(next.items.length, 1); assert.equal(next.items[0].text, 'separate assistant message');
  assert.notEqual(next.items[0].id, model.id);
});
test('unsettled abort and unseen subtypes remain visible instead of being guessed', async t => {
  const { readTranscript } = await api();
  const loc = shapeFixture(t, 'copilot', 'unsettled-shapes.jsonl');
  const result = readTranscript(loc);
  assert.equal(result.counts.unrecognized, 1);
  assert.equal(result.items[0].nativeType, 'abort');
  for (const [companion, record] of [
    ['codex', { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FutureItem', id: 'future' } } }],
    ['claude', { type: 'system', subtype: 'future.system', content: 'unknown' }],
    ['copilot', { type: 'system.notification', data: { kind: { type: 'future.notification' } } }],
    ['copilot', { type: 'model.future_lifecycle', data: {} }],
  ]) {
    const other = shapeFixture(t, companion); const first = readTranscript(other);
    appendFileSync(other.path, JSON.stringify(record) + '\n');
    assert.equal(readTranscript(other, { after: first.cursor }).counts.unrecognized, 1);
  }
});

// Second review: placeholder records from shapes-2.json only.
for (const companion of ['codex', 'claude', 'copilot']) {
  test(`${companion}: wider observed tail has deliberate mappings`, async t => {
    const { readTranscript } = await api();
    const loc = shapeFixture(t, companion, 'tail-shapes.jsonl');
    const result = readTranscript(loc);
    assert.equal(result.counts.unrecognized, 0, JSON.stringify(result.items.filter(i => i.kind === 'unrecognized').map(i => i.nativeType)));
    assert.equal(result.format.recognized, true, result.format.detail);
    if (companion === 'codex') {
      assert.deepEqual(result.items.map(i => i.kind), ['turn_end', 'tool', 'tool', 'tool', 'tool', 'tool', 'tool']);
      assert.equal(result.items[0].status, 'failed'); assert.equal(result.items[0].reason, 'interrupted');
      assert.equal(result.items[0].turnId, 'shape-turn');
      const message = result.items.find(i => i.nativeType === 'response_item/agent_message');
      assert.equal(message.name, 'agent_message'); assert.equal(message.text, 'agent communication');
      assert.equal(message.author, 'fixture-agent'); assert.equal(message.recipient, 'fixture-recipient');
      assert.ok(!JSON.stringify(result).includes('opaque-fixture-ciphertext'));
      const mcp = result.items.filter(i => i.nativeType.endsWith('/McpToolCall'));
      assert.deepEqual(mcp.map(i => i.name), ['agent_send', 'agent_wait', 'agent_wait']);
      assert.ok(mcp.every(i => i.server === 'agent-bridge' && i.status === 'completed'));
      assert.equal(mcp[0].input.task, 'fixture'); assert.equal(mcp[1].output, 'MCP result 1\n');
      assert.equal(mcp[1].result.content[1].type, 'resource_link');
      assert.equal(mcp[0].result.structuredContent.status, 'still_running', 'tool completion is separate from its reported job status');
      assert.equal(result.items.find(i => i.nativeType.endsWith('/SubAgentActivity')).name, 'interacted');
      assert.equal(result.items.find(i => i.nativeType.endsWith('/CollabAgentToolCall')).name, 'wait');
    } else if (companion === 'claude') {
      assert.deepEqual(result.items.map(i => i.kind), ['preamble', 'preamble', 'tool', 'tool', 'tool', 'user', 'user', 'user', 'user']);
      const boundary = result.items.find(i => i.nativeType === 'system/compact_boundary');
      assert.equal(boundary.text, 'Context compacted'); assert.equal(boundary.compactMetadata.preTokens, 1);
      assert.equal(result.items.find(i => i.nativeType === 'system/informational').text, 'Fixture notice');
      const commands = result.items.filter(i => i.nativeType === 'system/local_command');
      assert.ok(commands.every(i => i.name === 'local_command' && i.status === null && i.output === 'Fixture local command output'));
      assert.deepEqual(commands[1].commandRun, { command: 'fixture', args: '' });
      const images = result.items.filter(i => i.nativeType === 'user/image');
      assert.deepEqual(images.map(i => i.turnId), ['image-prompt-0', 'image-prompt-1', 'image-prompt-2']);
      assert.deepEqual(images.map(i => i.image), [{ sourceType: 'base64', mediaType: 'image/png' }, { sourceType: 'base64', mediaType: 'image/png' }, { sourceType: 'base64', mediaType: 'image/jpeg' }]);
      assert.ok(!JSON.stringify(result).includes('IMAGE_BYTES_MUST_NOT_SURVIVE'));
    } else {
      assert.deepEqual(result.items.map(i => i.kind), ['turn_end', 'turn_end', 'turn_end', 'turn_end']);
      assert.deepEqual(result.items.map(i => i.status), ['failed', 'failed', 'failed', 'completed']);
      assert.deepEqual(result.items.slice(0, 3).map(i => i.reason), ['user_abort', 'user_abort', 'user_initiated']);
      assert.equal(result.items.at(-1).text, 'Fixture task summary');
      assert.ok(result.items.every(i => i.turnId === null));
    }
    assert.deepEqual(readTranscript(loc, { after: result.cursor }).items, []);
  });
}
test('Claude image-only prompt establishes the native turn across reads without retaining bytes', async t => {
  const { readTranscript } = await api();
  const loc = shapeFixture(t, 'claude', 'tail-shapes.jsonl');
  const first = readTranscript(loc);
  appendFileSync(loc.path, JSON.stringify({ type: 'assistant', uuid: 'image-reply', sessionId: 'shapes', version: 'fixture', message: { content: [{ type: 'text', text: 'Image reply' }] } }) + '\n');
  const next = readTranscript(loc, { after: first.cursor });
  assert.equal(next.items.length, 1); assert.equal(next.items[0].turnId, 'image-prompt-2');
  assert.equal(next.items[0].text, 'Image reply');
  assert.ok(!JSON.stringify([...first.items, ...next.items]).includes('IMAGE_BYTES_MUST_NOT_SURVIVE'));
});
test('Codex interrupted terminal upserts by native turn; Copilot failed task stays failed', async t => {
  const { readTranscript } = await api();
  const codex = shapeFixture(t, 'codex', 'tail-shapes.jsonl');
  const first = readTranscript(codex);
  const record = { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'shape-turn', reason: 'interrupted', completed_at: 2 } };
  appendFileSync(codex.path, JSON.stringify(record) + '\n');
  const next = readTranscript(codex, { after: first.cursor });
  assert.equal(next.items.length, 1); assert.equal(next.items[0].kind, 'turn_end');
  assert.equal(next.items[0].id, first.items.find(i => i.kind === 'turn_end').id);
  assert.equal(next.items[0].status, 'failed');
  const copilot = shapeFixture(t, 'copilot', 'tail-shapes.jsonl');
  const before = readTranscript(copilot);
  appendFileSync(copilot.path, JSON.stringify({ type: 'session.task_complete', id: 'task-failed', data: { summary: 'Fixture task failed', success: false } }) + '\n');
  const failed = readTranscript(copilot, { after: before.cursor });
  assert.equal(failed.items.length, 1); assert.equal(failed.items[0].kind, 'turn_end');
  assert.equal(failed.items[0].status, 'failed'); assert.equal(failed.items[0].text, 'Fixture task failed');
});

// Live login runs, 2026-11-15 (scrubbed: steps and trajectory_meta only, the
// operator's home path replaced byte-for-byte): a command refused by
// AGENT_COMPANION_ANTIGRAVITY_PERMISSION=none, and one cancelled mid-run.
function antigravityRun(t, name, sessionId) {
  const path = join(temp(t), 'transcript');
  const db = new DatabaseSync(path);
  db.exec(readFileSync(new URL(`antigravity/${name}.sql`, root), 'utf8'));
  db.close();
  return { companion: 'antigravity', kind: 'sqlite', path, sessionId };
}
test('antigravity: a refused tool call is a failed command with the native reason', async t => {
  const { readTranscript } = await api();
  const result = readTranscript(antigravityRun(t, 'fixture-denied', 'cd0abe1c-3503-4c78-98c2-5483de4a8bd6'));
  assert.equal(result.counts.unrecognized, 0, result.format.detail);
  const command = result.items.find(i => i.kind === 'command');
  assert.equal(command.command, 'echo SHOULD-NOT-RUN');
  assert.equal(command.status, 'failed'); assert.equal(command.exitCode, null);
  assert.equal(command.denied, 'Denied by user (*).');
});
test('antigravity: a cancelled command keeps its native running status', async t => {
  const { readTranscript } = await api();
  const result = readTranscript(antigravityRun(t, 'fixture-cancelled', '6ed710c6-e92b-4fa1-bbf6-70ab9bbc7935'));
  assert.equal(result.counts.unrecognized, 0, result.format.detail);
  const command = result.items.find(i => i.kind === 'command');
  assert.equal(command.command, 'sleep 30 && echo LATE'); assert.equal(command.status, 'running');
});

test('opencode: a shell command a cancel or interrupt stopped is unfinished, not failed (measured on 2.3.0)', async t => {
  const { readTranscript } = await api();
  const loc = fixture(t, 'opencode');
  const before = readTranscript(loc);
  const db = new DatabaseSync(loc.path);
  // A user cancel: the part errors with `interrupted` and neither exit nor signal.
  const part = { id: 'prt_cancel', type: 'tool', name: 'shell', state: { status: 'error', input: { command: 'sleep 100' },
    error: { type: 'tool.execution', message: '[no output]' }, metadata: { shellID: 'sh_1', interrupted: true, truncated: false } } };
  db.prepare('INSERT INTO session_message VALUES(?,?,?,?,?,?,?)').run('msg_cancel', loc.sessionId, 'assistant', 998, 1, 1,
    JSON.stringify({ content: [part], error: { type: 'aborted', message: 'Step interrupted' }, time: { completed: 2 } }));
  db.close();
  const [command] = readTranscript(loc, { after: before.cursor }).items.filter(i => i.kind === 'command');
  assert.equal(command.status, 'unfinished');
  assert.equal(command.exitCode, null);
});

test('opencode: a shell command killed by its timeout is failed, naming the signal (measured on 2.3.0)', async t => {
  const { readTranscript } = await api();
  const loc = fixture(t, 'opencode');
  const before = readTranscript(loc);
  const db = new DatabaseSync(loc.path);
  const part = { id: 'prt_timeout', type: 'tool', name: 'shell', state: { status: 'completed', input: { command: 'sleep 150' },
    content: [{ type: 'text', text: 'Command timed out after 120 seconds.\nExit code: 143 (SIGTERM)' }],
    metadata: { status: 'completed', signal: 'SIGTERM', timeout: true } } };
  db.prepare('INSERT INTO session_message VALUES(?,?,?,?,?,?,?)').run('msg_timeout', loc.sessionId, 'assistant', 998, 1, 1,
    JSON.stringify({ content: [part], time: { completed: 2 } }));
  db.close();
  const [command] = readTranscript(loc, { after: before.cursor }).items.filter(i => i.kind === 'command');
  assert.equal(command.status, 'failed');
  assert.equal(command.exitCode, null);
  assert.equal(command.signal, 'SIGTERM');
});
