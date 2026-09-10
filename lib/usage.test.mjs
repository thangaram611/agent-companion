// lib/usage.test.mjs — the one usage shape and the per-transport readers.
//
// Every fixture here is a measured wire shape, not an invention: codex
// app-server's `ThreadTokenUsage` is the pinned contract's type; the exec
// `turn.completed.usage` keys were captured from codex-cli 0.154.0 on
// 2026-09-10; the Copilot OTEL span is a real `invoke_agent` span from the
// daemon's file exporter (Copilot CLI 1.0.77); the OpenCode message info is
// its OpenAPI `AssistantMessage`.
import '../test/sandbox-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  USAGE_COUNTERS,
  makeUsage,
  codexTurnBaseline,
  usageFromCodexTokenUsage,
  usageFromCodexExecUsage,
  usageFromCopilotOtel,
  usageFromOpenCodeInfo,
  sumUsage,
  formatUsage,
} from './usage.mjs';

const breakdown = (input, output, cached, reasoning, total, cacheWrite) => ({
  inputTokens: input, outputTokens: output, cachedInputTokens: cached,
  reasoningOutputTokens: reasoning, totalTokens: total,
  ...(cacheWrite === undefined ? {} : { cacheWriteInputTokens: cacheWrite }),
});

test('the shape: six counters under one spelling, absent rather than zeroed when nothing was reported', () => {
  assert.deepEqual(USAGE_COUNTERS, [
    'input_tokens', 'output_tokens', 'cached_input_tokens',
    'cache_write_input_tokens', 'reasoning_output_tokens', 'total_tokens',
  ]);
  const u = makeUsage({ source: 'test', input: 10, output: 4 });
  assert.deepEqual(u, {
    source: 'test',
    input_tokens: 10, output_tokens: 4,
    cached_input_tokens: null, cache_write_input_tokens: null, reasoning_output_tokens: null,
    // total defaults to input + output when the transport reports none.
    total_tokens: 14,
  });
  // Optional fields appear only when given.
  const full = makeUsage({ source: 'test', input: 1, output: 1, model: 'm', cost: 0.5, costUnit: 'usd', partial: true });
  assert.equal(full.model, 'm');
  assert.equal(full.cost, 0.5);
  assert.equal(full.cost_unit, 'usd');
  assert.equal(full.partial, true);
  assert.equal('partial' in u, false);
  assert.equal('model' in u, false);
  // Nothing reported is null, never {0,0,…}.
  assert.equal(makeUsage({ source: 'test' }), null);
  assert.equal(makeUsage({ source: 'test', input: null, output: undefined }), null);
  assert.throws(() => makeUsage({ input: 1, output: 1 }), /source/);
});

test('codex app-server: a resumed thread reports THIS turn, not the thread — the first notification sets the baseline', () => {
  // A thread that already spent 5000/800 before this turn; the first model
  // call of this turn adds 1000/100.
  const first = { total: breakdown(6000, 900, 4900, 110, 6900, 0), last: breakdown(1000, 100, 900, 10, 1100, 0), modelContextWindow: 258400 };
  const base = codexTurnBaseline(first);
  assert.deepEqual(base, breakdown(5000, 800, 4000, 100, 5800, 0));
  assert.deepEqual(usageFromCodexTokenUsage(first, base), {
    source: 'codex-app-server',
    input_tokens: 1000, output_tokens: 100, cached_input_tokens: 900,
    cache_write_input_tokens: 0, reasoning_output_tokens: 10, total_tokens: 1100,
  });
  // The second call of the turn accumulates against the same baseline.
  const second = { total: breakdown(7200, 1150, 6000, 140, 8350, 0), last: breakdown(1200, 250, 1100, 30, 1450, 0) };
  assert.equal(usageFromCodexTokenUsage(second, base).input_tokens, 2200);
  assert.equal(usageFromCodexTokenUsage(second, base).total_tokens, 2550);
  // A fresh thread: total == last, so the baseline is zero.
  const fresh = { total: breakdown(100, 20, 0, 5, 120), last: breakdown(100, 20, 0, 5, 120) };
  assert.deepEqual(codexTurnBaseline(fresh), breakdown(0, 0, 0, 0, 0, null));
  assert.equal(usageFromCodexTokenUsage(fresh, codexTurnBaseline(fresh)).input_tokens, 100);
  // `cacheWriteInputTokens` is optional on the wire and stays null when absent.
  assert.equal(usageFromCodexTokenUsage(fresh, null).cache_write_input_tokens, null);
  assert.equal(usageFromCodexTokenUsage(null, null), null);
  assert.equal(codexTurnBaseline(null), null);
});

test('codex exec: the five turn.completed counters, no total and no model on that stream', () => {
  const u = usageFromCodexExecUsage({ input_tokens: 21219, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 });
  assert.deepEqual(u, {
    source: 'codex-exec',
    input_tokens: 21219, output_tokens: 5, cached_input_tokens: 0,
    cache_write_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: 21224,
  });
  assert.equal(usageFromCodexExecUsage({}), null);
  assert.equal(usageFromCodexExecUsage(null), null);
});

const otelSpan = ({ name = 'invoke_agent', conversationId, startSec, input = 24869, output = 4 }) => JSON.stringify({
  type: 'span', traceId: 't', spanId: 's', name, kind: 1,
  startTime: [startSec, 211000000], endTime: [startSec + 3, 0],
  attributes: {
    'gen_ai.operation.name': name, 'gen_ai.provider.name': 'github',
    'gen_ai.conversation.id': conversationId, 'gen_ai.request.model': 'claude-sonnet-5',
    'gen_ai.usage.input_tokens': input, 'gen_ai.usage.output_tokens': output,
    'gen_ai.usage.cache_creation.input_tokens': 24867, 'gen_ai.usage.cache_read.input_tokens': 2,
    'gen_ai.usage.reasoning.output_tokens': 11,
    'gen_ai.response.model': 'claude-sonnet-5', 'github.copilot.cost': 1,
  },
});

test('copilot OTEL: the invoke_agent spans of THIS prompt on THIS conversation, summed, with model and cost', () => {
  const sid = 'fbb46626-3cc7-4f3a-adaf-6121aa4dfd6a';
  const since = Date.UTC(2026, 8, 10, 6, 0, 0);
  const sec = Math.floor(since / 1000);
  const text = [
    // An earlier prompt on the same conversation: outside the window.
    otelSpan({ conversationId: sid, startSec: sec - 600, input: 999999 }),
    // Another session entirely.
    otelSpan({ conversationId: 'other', startSec: sec + 1, input: 999999 }),
    // The per-model-call child span: not the per-prompt aggregate.
    otelSpan({ name: 'chat claude-sonnet-5', conversationId: sid, startSec: sec + 1, input: 999999 }),
    // A metric record, which is not a span at all.
    JSON.stringify({ type: 'metric', name: 'gen_ai.client.token.usage', dataPoints: [] }),
    // The prompt's own aggregate, and a second one (a sub-agent invocation) in the same window.
    otelSpan({ conversationId: sid, startSec: sec + 1 }),
    otelSpan({ conversationId: sid, startSec: sec + 2, input: 100, output: 10 }),
    'not json at all',
  ].join('\n') + '\n';
  const u = usageFromCopilotOtel(text, { conversationId: sid, sinceMs: since });
  assert.deepEqual(u, {
    source: 'copilot-otel',
    input_tokens: 24969, output_tokens: 14, cached_input_tokens: 4,
    cache_write_input_tokens: 49734, reasoning_output_tokens: 22, total_tokens: 24983,
    model: 'claude-sonnet-5', cost: 2, cost_unit: 'copilot_premium_requests',
  });
  // Nothing in the window is no usage, not zero usage.
  assert.equal(usageFromCopilotOtel(text, { conversationId: sid, sinceMs: since + 3_600_000 }), null);
  assert.equal(usageFromCopilotOtel('', { conversationId: sid, sinceMs: since }), null);
  // The span's own start can precede the daemon's recorded start by a little
  // (clock reads on two sides of an IPC): a small slack is allowed.
  assert.ok(usageFromCopilotOtel(otelSpan({ conversationId: sid, startSec: sec - 2 }), { conversationId: sid, sinceMs: since }));
});

test('opencode: message info tokens, cost in usd and the model id, for either adapter', () => {
  const info = { role: 'assistant', modelID: 'gpt-oss:120b', providerID: 'ollama', cost: 0.0123, tokens: { input: 900, output: 120, reasoning: 30, cache: { read: 400, write: 50 } } };
  assert.deepEqual(usageFromOpenCodeInfo(info, 'opencode-server'), {
    source: 'opencode-server',
    input_tokens: 900, output_tokens: 120, cached_input_tokens: 400,
    cache_write_input_tokens: 50, reasoning_output_tokens: 30, total_tokens: 1020,
    model: 'gpt-oss:120b', cost: 0.0123, cost_unit: 'usd',
  });
  // A reported total is carried as-is; it is only computed when absent.
  assert.equal(usageFromOpenCodeInfo({ tokens: { input: 1, output: 1, total: 9 } }, 'opencode-server').total_tokens, 9);
  assert.equal(usageFromOpenCodeInfo({ role: 'assistant' }, 'opencode-server'), null);
  assert.equal(usageFromOpenCodeInfo({ tokens: { input: 1, output: 1 } }, 'opencode-cli').source, 'opencode-cli');
  assert.equal(usageFromOpenCodeInfo(null, 'opencode-cli'), null);
});

test('sumUsage adds counters null-aware, keeps a single model, sums cost, and carries partial', () => {
  const a = makeUsage({ source: 's', input: 10, output: 2, cached: 5, model: 'm', cost: 1, costUnit: 'usd' });
  const b = makeUsage({ source: 's', input: 20, output: 3, reasoning: 7, model: 'm', cost: 0.5, costUnit: 'usd', partial: true });
  assert.deepEqual(sumUsage([a, b]), {
    source: 's',
    input_tokens: 30, output_tokens: 5, cached_input_tokens: 5,
    cache_write_input_tokens: null, reasoning_output_tokens: 7, total_tokens: 35,
    model: 'm', cost: 1.5, cost_unit: 'usd', partial: true,
  });
  assert.equal(sumUsage([]), null);
  assert.equal(sumUsage([null, undefined]), null);
  // Two models is no single model.
  const c = makeUsage({ source: 's', input: 1, output: 1, model: 'other' });
  assert.equal('model' in sumUsage([a, c]), false);
});

test('formatUsage renders one line the digests share', () => {
  const u = makeUsage({ source: 'codex-exec', input: 21219, output: 5, cached: 0, cacheWrite: 0, reasoning: 0 });
  assert.equal(formatUsage(u), 'in=21219 out=5 cached=0 cache_write=0 reasoning=0 total=21224 (codex-exec)');
  const c = makeUsage({ source: 'copilot-otel', input: 1, output: 2, model: 'claude-sonnet-5', cost: 1, costUnit: 'copilot_premium_requests', partial: true });
  assert.equal(formatUsage(c), 'in=1 out=2 total=3 model=claude-sonnet-5 cost=1 copilot_premium_requests (copilot-otel, partial)');
  assert.equal(formatUsage(null), '');
});
