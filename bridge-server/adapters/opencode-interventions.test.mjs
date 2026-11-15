import '../../test/sandbox-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { SANDBOX_HOME } from '../../test/sandbox-home.mjs';
import { ManualClock } from '../../test/controller/helpers.mjs';
import { Controller } from '../controller/controller.mjs';
import { Records } from '../controller/records.mjs';
import { opencodeProvider } from './opencode.mjs';
import { readTranscript } from '../../lib/transcripts.mjs';
import { selectTurnItems, summarizeWork } from '../../lib/work-summary.mjs';
import { renderDigest } from '../../lib/digest.mjs';

test('m3 steer admission joins the actual store turn id through controller, work summary and digest', async t => {
  const fixture = JSON.parse(readFileSync(new URL('../../test/fixtures/interventions/opencode.json', import.meta.url)));
  const dir = mkdtempSync(join(SANDBOX_HOME, 'opencode-m3-')), path = join(dir, 'opencode.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE migration(id TEXT); CREATE TABLE session_v2(id TEXT, directory TEXT);'
    + 'CREATE TABLE session_message(id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);');
  db.prepare('INSERT INTO migration VALUES (?)').run(fixture.version);
  db.prepare('INSERT INTO session_v2 VALUES (?, ?)').run(fixture.sessionId, '/fixture/work');
  const insert = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)');
  for (const r of fixture.rows) insert.run(r.id, r.session_id, r.type, r.seq, r.time_created, JSON.stringify(r.data));
  db.close();

  const clock = new ManualClock(), env = { ...process.env, HOME: dir, OPENCODE_DB: path, AGENT_COMPANION_OPENCODE_MODEL: '' };
  const adapter = opencodeProvider({ env }).create(), stream = new PassThrough(), requests = [];
  // Replay measured admissions/store data through the real adapter and controller.
  // Process reuse and actual HTTP framing are covered by opencode.test.mjs.
  adapter.start = async ({ cwd }) => { adapter.cwd = cwd; adapter.clock = clock; };
  adapter._request = async (path, options = {}) => {
    requests.push({ path, ...options });
    if (path === '/event') return stream;
    if (path === '/session') return { data: { data: { id: fixture.sessionId, model: fixture.rows[0].data.model } } };
    if (path.endsWith('/prompt')) {
      const ack = requests.filter(r => r.path.endsWith('/prompt')).length === 1 ? fixture.first : fixture.steer;
      assert.deepEqual(options.body, { text: ack.payload.text });
      return { data: { data: ack } };
    }
    if (path.includes('/message?')) return { data: { data: fixture.rows.toReversed().map(r => ({ id: r.id, type: r.type, ...r.data })) } };
    throw new Error(`unexpected request: ${path}`);
  };
  const records = new Records({ dir: join(dir, 'records'), log() {} });
  const controller = new Controller({ clock, records, env,
    snapshot: async () => ({ available: false, reason: 'fixture' }),
    providers: { opencode: { enabled: true, ready: true, create: () => adapter } },
    createSupervisor: () => ({ async terminate() { return { gone: true }; }, async quiesce() {}, async census() {}, serialize() { return {}; } }),
  });
  t.after(async () => { for (const a of controller.live.values()) clock.clearTimeout(a.timer); stream.destroy(); await adapter.close(); });
  const sent = await controller.send({ owner: 'child', provider: 'opencode', cwd: dir, text: fixture.first.payload.text });
  const ack = await controller.intervene({ executionId: sent.executionId, from: 'user', mode: 'steer', text: fixture.steer.payload.text });
  const joined = records.readExecution(sent.executionId);
  assert.deepEqual(joined.nativeTurnIds, [fixture.first.id, fixture.steer.id]);
  assert.equal(joined.interventions[0].state, 'joined');
  stream.write(`data: ${JSON.stringify({ type: 'session.execution.succeeded', data: { sessionID: fixture.sessionId } })}\n\n`);
  const result = await controller.wait({ owner: 'child', executionId: sent.executionId });
  const execution = records.readExecution(sent.executionId);
  assert.equal(result.text, 'ORIGINAL-A\n\nBANANA-42');
  assert.equal(result.turns.length, 1); assert.deepEqual(result.turns[0].messages, [sent.executionId, ack.id]);
  assert.equal(result.usage.input_tokens, 3574); assert.equal(result.usage.output_tokens, 275);
  const transcript = readTranscript(execution.transcript);
  assert.equal(transcript.format.recognized, true);
  assert.equal(transcript.items.find(i => i.kind === 'assistant').turnId, fixture.steer.id);
  const selected = selectTurnItems(transcript.items, { companion: 'opencode', nativeTurnIds: result.nativeTurnIds });
  assert.deepEqual(selected, transcript.items);
  assert.equal(result.workSummary.commands[0].exitCode, 0);
  const digest = renderDigest(execution, result, env);
  assert.match(digest.split('## Transcript')[1], /ORIGINAL-A\s+BANANA-42/);
  assert.match(digest.split('## Transcript')[1], /MIDTURN-B/);
  // Synthetic later work verifies the same selection also covers commands and edits.
  const later = [...transcript.items, { kind: 'command', turnId: fixture.steer.id, command: 'after-steer', exitCode: 0 },
    { kind: 'edit', turnId: fixture.steer.id, paths: [{ path: 'after.txt', change: 'add' }] },
    { kind: 'command', turnId: 'other-job', command: 'excluded' }];
  const summary = summarizeWork({ items: selectTurnItems(later, { companion: 'opencode', nativeTurnIds: result.nativeTurnIds }) });
  assert.equal(summary.commands.at(-1).command, 'after-steer');
  assert.deepEqual(summary.edits, [{ path: 'after.txt', change: 'add' }]);
});
