import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTurnAccumulator, parseOpenCodeModel } from './opencode-protocol.mjs';
const SID = 'ses_abc';
const V2 = JSON.parse(readFileSync(new URL('../../test/fixtures/opencode-v2-turn.json', import.meta.url), 'utf8'));
const frame = (evt) => `data: ${JSON.stringify(evt)}\n\n`;
test('captured native v2 events retain final text, earlier tool steps and per-turn usage', () => {
  const acc = createTurnAccumulator(V2.sessionId);
  feed(acc, V2.events.map(frame));
  assert.equal(acc.terminal.status, 'completed');
  const snap = acc.snapshot();
  assert.equal(snap.message, 'MANGO');
  assert.equal(snap.toolCalls.length, 1);
  assert.equal(snap.toolCalls[0].name, 'read');
  assert.equal(snap.toolCalls[0].input.path, 'README.md');
  assert.equal(snap.usage.input_tokens, 7078);
  assert.equal(snap.usage.output_tokens, 62);
  assert.equal(snap.usage.cached_input_tokens, 8816);
  assert.equal(snap.usage.model, 'gpt-oss:120b');
});

test('v2 global events ignore foreign sessions and classify interrupted/failed executions', () => {
  const acc = createTurnAccumulator(V2.sessionId);
  feed(acc, V2.events.map(e => frame({ ...e, data: { ...e.data, sessionID: 'ses_foreign' } })));
  assert.equal(acc.terminal, null);
  assert.equal(acc.snapshot().message, '');
  feed(acc, [frame({ type: 'session.execution.interrupted', data: { sessionID: V2.sessionId } })]);
  assert.equal(acc.terminal.status, 'cancelled');
  const failed = createTurnAccumulator(V2.sessionId);
  feed(failed, [frame({ type: 'session.execution.failed', data: { sessionID: V2.sessionId, error: { type: 'ProviderError', message: 'quota exhausted' } } })]);
  assert.equal(failed.terminal.status, 'failed');
  assert.equal(failed.snapshot().error, 'quota exhausted');
});

function feed(acc, frames) {
  for (const f of frames) acc.push(f);
  acc.flush();
}

test('accumulator assembles assistant text and resolves completed on session.idle', () => {
  const acc = createTurnAccumulator(SID);
  feed(acc, [
    frame({ type: 'message.updated', properties: { sessionID: SID, info: { role: 'assistant', id: 'msg1' } } }),
    frame({ type: 'message.part.updated', properties: { sessionID: SID, part: { id: 'p1', messageID: 'msg1', type: 'text', text: 'Hello ' } } }),
    frame({ type: 'message.part.updated', properties: { sessionID: SID, part: { id: 'p2', messageID: 'msg1', type: 'text', text: 'world' } } }),
    frame({ type: 'session.idle', properties: { sessionID: SID } }),
  ]);
  assert.deepEqual(acc.terminal, { status: 'completed' });
  assert.equal(acc.snapshot().message, 'Hello world');
});

test('accumulator reads the assistant message info\'s tokens, cost and model as the turn\'s usage', () => {
  const acc = createTurnAccumulator(SID);
  const info = (extra) => ({ role: 'assistant', id: 'msg1', modelID: 'gpt-oss:120b', providerID: 'ollama', ...extra });
  feed(acc, [
    frame({ type: 'message.updated', properties: { sessionID: SID, info: info({}) } }),
    frame({ type: 'message.part.updated', properties: { sessionID: SID, part: { id: 'p1', messageID: 'msg1', type: 'text', text: 'answer' } } }),
  ]);
  assert.equal('usage' in acc.snapshot(), false, 'no tokens yet is no usage key');
  feed(acc, [
    // OpenCode re-sends the info as the message completes, tokens now filled.
    frame({ type: 'message.updated', properties: { sessionID: SID, info: info({ cost: 0.0123, tokens: { input: 900, output: 120, reasoning: 30, cache: { read: 400, write: 50 } }, time: { created: 1, completed: 2 } }) } }),
    // Another session's usage never lands here.
    frame({ type: 'message.updated', properties: { sessionID: 'other', info: info({ id: 'x', tokens: { input: 99999, output: 99999 } }) } }),
    frame({ type: 'session.idle', properties: { sessionID: SID } }),
  ]);
  assert.deepEqual(acc.snapshot().usage, {
    source: 'opencode-server',
    input_tokens: 900, output_tokens: 120, cached_input_tokens: 400,
    cache_write_input_tokens: 50, reasoning_output_tokens: 30, total_tokens: 1020,
    model: 'gpt-oss:120b', cost: 0.0123, cost_unit: 'usd',
  });
});

test('accumulator keeps tool-only turn non-empty via toolCalls', () => {
  const acc = createTurnAccumulator(SID);
  feed(acc, [
    frame({ type: 'message.part.updated', properties: { sessionID: SID, part: { id: 't1', messageID: 'msg1', type: 'tool', tool: 'bash', state: { input: { cmd: 'ls' } } } } }),
    frame({ type: 'session.idle', properties: { sessionID: SID } }),
  ]);
  assert.equal(acc.terminal.status, 'completed');
  const snap = acc.snapshot();
  assert.equal(snap.message, '');
  assert.equal(snap.toolCalls.length, 1);
  assert.equal(snap.toolCalls[0].name, 'bash');
});

test('accumulator routes reasoning to thoughts, not message', () => {
  const acc = createTurnAccumulator(SID);
  feed(acc, [
    frame({ type: 'message.part.updated', properties: { sessionID: SID, part: { id: 'r1', messageID: 'msg1', type: 'reasoning', text: 'thinking...' } } }),
    frame({ type: 'message.part.updated', properties: { sessionID: SID, part: { id: 'p1', messageID: 'msg1', type: 'text', text: 'answer' } } }),
    frame({ type: 'session.idle', properties: { sessionID: SID } }),
  ]);
  const snap = acc.snapshot();
  assert.equal(snap.message, 'answer');
  assert.equal(snap.thoughts, 'thinking...');
});

test('accumulator maps abort to cancelled', () => {
  const acc = createTurnAccumulator(SID);
  feed(acc, [
    frame({ type: 'message.updated', properties: { sessionID: SID, info: { role: 'assistant', id: 'msg1', error: { name: 'MessageAbortedError', message: 'aborted' } } } }),
    frame({ type: 'session.idle', properties: { sessionID: SID } }),
  ]);
  assert.equal(acc.terminal.status, 'cancelled');
});

test('accumulator maps session.error to failed', () => {
  const acc = createTurnAccumulator(SID);
  feed(acc, [
    frame({ type: 'session.error', properties: { sessionID: SID, error: { name: 'ProviderAuthError', message: 'no key' } } }),
  ]);
  assert.equal(acc.terminal.status, 'failed');
  assert.equal(acc.snapshot().error, 'no key');
});

test('accumulator ignores foreign sessions and global noise', () => {
  const acc = createTurnAccumulator(SID);
  feed(acc, [
    frame({ type: 'server.heartbeat', properties: {} }),
    frame({ type: 'message.part.updated', properties: { sessionID: 'ses_other', part: { id: 'x', messageID: 'm', type: 'text', text: 'NOPE' } } }),
    frame({ type: 'session.idle', properties: { sessionID: 'ses_other' } }),
  ]);
  assert.equal(acc.terminal, null);
  assert.equal(acc.snapshot().message, '');
});

test('accumulator parses split frames across push boundaries', () => {
  const acc = createTurnAccumulator(SID);
  const f = frame({ type: 'message.part.updated', properties: { sessionID: SID, part: { id: 'p1', messageID: 'msg1', type: 'text', text: 'chunked' } } });
  acc.push(f.slice(0, 10));
  acc.push(f.slice(10));
  acc.push(frame({ type: 'session.idle', properties: { sessionID: SID } }));
  acc.flush();
  assert.equal(acc.terminal.status, 'completed');
  assert.equal(acc.snapshot().message, 'chunked');
});



test('model parser splits provider/model and rejects malformed values', () => {
  assert.equal(parseOpenCodeModel(null), null);
  assert.deepEqual(parseOpenCodeModel('ollama-cloud/gpt-oss:120b'), { providerID: 'ollama-cloud', modelID: 'gpt-oss:120b' });
  for (const raw of ['noslash', '/leading', 'trailing/']) assert.equal(parseOpenCodeModel(raw), null);
});
