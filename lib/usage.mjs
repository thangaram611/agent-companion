// lib/usage.mjs — the one per-job usage shape, and the readers that fill it
// from each transport's own signal.
//
// Every companion reports tokens in its own vocabulary: codex app-server sends
// `thread/tokenUsage/updated` (a thread-cumulative `ThreadTokenUsage`), codex
// exec puts five snake_case counters on `turn.completed`, Copilot writes OTEL
// spans to a file exporter, OpenCode carries `tokens`/`cost` on its assistant
// message info. They meet here, once, so the ledger, wait meta, status and the
// digests all read the same keys — and a routing or cost decision downstream
// has one field to look at rather than four dialects.
//
// Two rules the shape enforces:
//   - a transport that reported nothing yields `null`, never `{0, 0, …}`: an
//     absent field is the honest answer, a zero is a claim;
//   - a counter the transport does not report is `null` inside the object, so
//     the keys are the same everywhere and "unknown" is distinguishable from
//     "zero" (codex exec has no total; Copilot's spans have no cached-read on
//     a cold prompt; OpenCode has no reasoning on some providers).

export const USAGE_COUNTERS = Object.freeze([
  'input_tokens',
  'output_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens',
  'reasoning_output_tokens',
  'total_tokens',
]);

function count(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function makeUsage({
  source,
  input = null, output = null, cached = null, cacheWrite = null, reasoning = null, total = null,
  model = null, cost = null, costUnit = null, partial = false,
} = {}) {
  if (!source) throw new Error('makeUsage: source is required');
  const i = count(input);
  const o = count(output);
  if (i === null && o === null) return null;
  const usage = {
    source: String(source),
    input_tokens: i,
    output_tokens: o,
    cached_input_tokens: count(cached),
    cache_write_input_tokens: count(cacheWrite),
    reasoning_output_tokens: count(reasoning),
    // Input plus output when the transport reports no total of its own. The
    // cached and reasoning counters are components of input and output on
    // every transport here, not additions to them.
    total_tokens: count(total) ?? (i ?? 0) + (o ?? 0),
  };
  if (model) usage.model = String(model);
  const c = count(cost);
  if (c !== null) {
    usage.cost = c;
    if (costUnit) usage.cost_unit = String(costUnit);
  }
  if (partial) usage.partial = true;
  return usage;
}

// Element-wise, null-aware: a counter is the sum of the entries that reported
// it, and null only when none did. One model survives only if every entry
// agrees on it; cost is summed in the first entry's unit.
export function sumUsage(list) {
  const entries = (Array.isArray(list) ? list : []).filter(Boolean);
  if (!entries.length) return null;
  const sumOf = (key) => {
    const reported = entries.map((u) => u[key]).filter((v) => v !== null && v !== undefined);
    return reported.length ? reported.reduce((a, b) => a + b, 0) : null;
  };
  const models = new Set(entries.map((u) => u.model).filter(Boolean));
  const costs = entries.map((u) => u.cost).filter((v) => v !== null && v !== undefined);
  return makeUsage({
    source: entries[0].source,
    input: sumOf('input_tokens'),
    output: sumOf('output_tokens'),
    cached: sumOf('cached_input_tokens'),
    cacheWrite: sumOf('cache_write_input_tokens'),
    reasoning: sumOf('reasoning_output_tokens'),
    total: sumOf('total_tokens'),
    model: models.size === 1 && entries.every((u) => u.model) ? [...models][0] : null,
    cost: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
    costUnit: entries.find((u) => u.cost_unit)?.cost_unit ?? null,
    partial: entries.some((u) => u.partial),
  });
}

// --- codex app-server ---------------------------------------------------------
//
// `ThreadTokenUsage { total, last, modelContextWindow? }`, where `total` is the
// THREAD's cumulative usage and `last` the last model call's. A follow-up send
// resumes a thread that already spent tokens in earlier turns, so this turn's
// usage is `total` minus what the thread had spent before its first call —
// which is exactly the first notification's `total − last`.

const BREAKDOWN_KEYS = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens', 'totalTokens', 'cacheWriteInputTokens'];

function breakdownDiff(a, b) {
  const out = {};
  for (const key of BREAKDOWN_KEYS) {
    const x = count(a?.[key]);
    const y = count(b?.[key]);
    out[key] = x === null || y === null ? null : x - y;
  }
  return out;
}

export function codexTurnBaseline(tokenUsage) {
  if (!tokenUsage?.total || !tokenUsage?.last) return null;
  return breakdownDiff(tokenUsage.total, tokenUsage.last);
}

export function usageFromCodexTokenUsage(tokenUsage, baseline = null) {
  const total = tokenUsage?.total;
  if (!total) return null;
  const minus = (key) => {
    const t = count(total[key]);
    if (t === null) return null;
    return t - (count(baseline?.[key]) ?? 0);
  };
  return makeUsage({
    source: 'codex-app-server',
    input: minus('inputTokens'),
    output: minus('outputTokens'),
    cached: minus('cachedInputTokens'),
    cacheWrite: minus('cacheWriteInputTokens'),
    reasoning: minus('reasoningOutputTokens'),
    total: minus('totalTokens'),
  });
}

// --- codex exec -----------------------------------------------------------------
//
// `turn.completed.usage` on codex-cli 0.154.0 (measured 2026-09-10):
// `{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens,
// reasoning_output_tokens}` — no total, and the stream never names the model.

export function usageFromCodexExecUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return makeUsage({
    source: 'codex-exec',
    input: usage.input_tokens,
    output: usage.output_tokens,
    cached: usage.cached_input_tokens,
    cacheWrite: usage.cache_write_input_tokens,
    reasoning: usage.reasoning_output_tokens,
  });
}

// --- Copilot ----------------------------------------------------------------
//
// The daemon runs Copilot with `COPILOT_OTEL_FILE_EXPORTER_PATH`. Measured
// against Copilot CLI 1.0.77 on 2026-09-10: the ACP stream carries no usage
// kind and `session/prompt` answers `{stopReason}` only, but the exporter
// writes one `invoke_agent` span per prompt — `gen_ai.usage.*` semconv
// attributes, `gen_ai.conversation.id` = the ACP session id, and
// `github.copilot.cost` in premium-request units — and it landed 0.00 s after
// the prompt result. The per-model-call `chat <model>` spans are its children
// and are not read: the aggregate is the prompt.
//
// `sinceMs` is the daemon's own prompt start. A span is this prompt's when it
// ENDED after that start — a span ends at the prompt's result, so the previous
// prompt's span, however recent, ended before this one began — and started
// no earlier than a few seconds before it: the span's clock is read on the
// other side of an IPC, and the slack keeps a skew from dropping a real span
// without reaching back to a prompt that is minutes, not seconds, older.
const OTEL_START_SLACK_MS = 5_000;

function otelMs(stamp) {
  const [sec, nanos] = Array.isArray(stamp) ? stamp : [];
  if (!Number.isFinite(sec)) return null;
  return sec * 1000 + (Number.isFinite(nanos) ? nanos / 1e6 : 0);
}

export function usageFromCopilotOtel(text, { conversationId, sinceMs } = {}) {
  if (!text || !conversationId) return null;
  const spans = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.type !== 'span' || record?.name !== 'invoke_agent') continue;
    const attrs = record.attributes || {};
    if (attrs['gen_ai.conversation.id'] !== conversationId) continue;
    if (Number.isFinite(sinceMs)) {
      const startedAt = otelMs(record.startTime);
      const endedAt = otelMs(record.endTime);
      if (startedAt === null || startedAt < sinceMs - OTEL_START_SLACK_MS) continue;
      if (endedAt !== null && endedAt < sinceMs) continue;
    }
    spans.push(makeUsage({
      source: 'copilot-otel',
      input: attrs['gen_ai.usage.input_tokens'],
      output: attrs['gen_ai.usage.output_tokens'],
      cached: attrs['gen_ai.usage.cache_read.input_tokens'],
      cacheWrite: attrs['gen_ai.usage.cache_creation.input_tokens'],
      reasoning: attrs['gen_ai.usage.reasoning.output_tokens'],
      model: attrs['gen_ai.response.model'] ?? attrs['gen_ai.request.model'] ?? null,
      cost: attrs['github.copilot.cost'],
      costUnit: 'copilot_premium_requests',
    }));
  }
  return sumUsage(spans);
}

// --- OpenCode -----------------------------------------------------------------
//
// An assistant message's `info` (its OpenAPI `AssistantMessage`, opencode
// 1.18.30): `tokens {input, output, reasoning, cache: {read, write}, total?}`,
// `cost` in USD, `modelID`. The same `tokens`/`cost` ride a `step-finish` part
// on the CLI's JSON stream (`StepFinishPart`), which is why the reader takes
// the fields rather than the event.

export function usageFromOpenCodeInfo(info, source) {
  const tokens = info?.tokens;
  if (!tokens || typeof tokens !== 'object') return null;
  const cost = count(info.cost);
  return makeUsage({
    source,
    input: tokens.input,
    output: tokens.output,
    cached: tokens.cache?.read,
    cacheWrite: tokens.cache?.write,
    reasoning: tokens.reasoning,
    total: tokens.total,
    model: info.modelID ?? null,
    cost,
    costUnit: cost === null ? null : 'usd',
  });
}

// One line for the digests, in the counters' order, naming only what was
// reported: `in=… out=… cached=… cache_write=… reasoning=… total=… model=… cost=… <unit> (<source>[, partial])`.
export function formatUsage(usage) {
  if (!usage) return '';
  const labels = { input_tokens: 'in', output_tokens: 'out', cached_input_tokens: 'cached', cache_write_input_tokens: 'cache_write', reasoning_output_tokens: 'reasoning', total_tokens: 'total' };
  const parts = [];
  for (const key of USAGE_COUNTERS) {
    if (usage[key] !== null && usage[key] !== undefined) parts.push(`${labels[key]}=${usage[key]}`);
  }
  if (usage.model) parts.push(`model=${usage.model}`);
  if (usage.cost !== null && usage.cost !== undefined) parts.push(`cost=${usage.cost}${usage.cost_unit ? ` ${usage.cost_unit}` : ''}`);
  return `${parts.join(' ')} (${usage.source}${usage.partial ? ', partial' : ''})`;
}
