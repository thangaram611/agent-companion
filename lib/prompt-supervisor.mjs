// prompt-supervisor.mjs
// Unified supervisor for Copilot ACP prompts. Replaces the old
// stuck-detection + external watchdog split with a single in-daemon module
// that speaks two surfaces:
//
//   1. Event-level — `Supervisor.observe(event, state)` is called for every
//      JSONL event. Detects loops, failure streaks, output-preview negatives,
//      exploration without progress, and unresolved tool calls. Returns
//      { action: 'ok' | 'trip', reason, autoCancelOk? }.
//
//   2. Poll-level — `pollSupervisor(state, nowMs)` is called by a daemon
//      setInterval ~10s. Detects silence and age thresholds. Returns
//      { action: 'ok' | 'alert' | 'trip', reason, tier }. The 'alert' tier
//      enqueues a non-terminal watchdog event (surfaced via hook drain) so Claude can inspect and
//      decide what to do; the 'trip' tier cancels the session.
//
// Per-prompt state mutated by this module:
//   state._supervisor       — event-level counters (initialized on first observe)
//   state._lastAlertTs      — set by the daemon when it emits a poll-level alert
//                             (used by pollSupervisor to enforce alertCooldownMs)

import { parseToolLineRange } from './prompt-utils.mjs';

export const DEFAULTS = {
  // --- Event-level (Supervisor.observe) ---
  failuresLimit: 3,
  recentToolCallWindow: 5,
  recentToolCallTrip: 3,
  recentViewWindow: 8,
  recentViewTrip: 6,
  // Windowed negatives: trip only when N negatives land inside the last M
  // tool_call_updates-with-preview. A raw counter (prior design) accumulated
  // forever and tripped on scattered grep-misses across a long session.
  outputNegativeWindow: 6,
  outputNegativeTrip: 3,
  // No tool-calls-without-message cap. /fleet decomposition + rubber-duck
  // sub-agents legitimately fan out hundreds of distinct, succeeding tool
  // calls before the outer session synthesizes. Genuine stuck-forever cases
  // are caught by poll-level silenceTripMs; loops by hash/view detection;
  // error storms by per-tool failure streaks. A pure-progress counter just
  // killed live research mid-flight.

  // --- Poll-level (pollSupervisor) ---
  // Tier 1 (alert): enqueue watchdog event for hook drain, keep running.
  silenceAlertMs: 120_000,
  firstEventSilenceAlertMs: 180_000,
  ageAlertMs: 300_000,
  alertCooldownMs: 60_000,

  // Tier 2 (trip): cancel session.
  silenceTripMs: 240_000,
  firstEventSilenceTripMs: 360_000,
};

const NEGATIVE_PREVIEW_PATTERNS = [
  /permission denied/i,
  /\bno matches?\b/i,
  /\bnot found\b/i,
];

const BENIGN_READ_MISS_PATTERNS = [
  /^\s*no matches? found\.?\s*$/i,
  /^\s*no files matched(?: the pattern)?\.?\s*$/i,
];

// --- per-state counter init -------------------------------------------------

function ensureCounters(state) {
  if (state._supervisor) return state._supervisor;
  state._supervisor = {
    failuresByTool: Object.create(null), // tool_name -> consecutive failure count
    recentToolCallHashes: [],
    recentViewExacts: [],
    recentOutputNegatives: [], // bounded array of booleans (true = negative preview)
  };
  return state._supervisor;
}

// The supervisor keys per-tool failure counters on the update's `name` (which
// the daemon now attaches to tool_call_update stream events by joining against
// the earlier tool_call). Older events without a name fall back to a shared
// bucket so behavior matches the pre-per-tool supervisor for that edge case.
function toolKey(update) {
  return update.name || update.kind || '<unnamed>';
}

// --- helpers ----------------------------------------------------------------

function hashToolCall(event) {
  const name = event.name || '';
  const input = event.input == null ? '' : JSON.stringify(event.input);
  return `${name}::${input}`;
}

function viewExactKey(event) {
  const inp = event.input || {};
  const path = inp.path || inp.file_path || inp.absolute_path || '';
  const { start, end } = parseToolLineRange(inp);
  return `${path}|${start}|${end}`;
}

function isViewEvent(event) {
  if (event.type !== 'tool_call') return false;
  const name = (event.name || '').toLowerCase();
  if (/^(view|read|viewing|reading)\b/.test(name)) return true;
  if (event.kind === 'read') {
    const inp = event.input || {};
    // Copilot tags grep/glob with kind:'read' — exclude those from view-loop detection.
    if (inp.pattern != null || inp.glob != null) return false;
    if (inp.path || inp.file_path || inp.absolute_path) return true;
  }
  return false;
}

function isReadSearchProbe(event) {
  const kind = (event.kind || '').toLowerCase();
  const name = (event.name || '').toLowerCase();
  if (kind === 'read') return true;
  return /^(searching for|finding files|grep|glob)\b/.test(name);
}

function isBenignReadMiss(event) {
  if (event.status !== 'completed') return false;
  if (!isReadSearchProbe(event)) return false;
  if (typeof event.outputPreview !== 'string') return false;
  return BENIGN_READ_MISS_PATTERNS.some((re) => re.test(event.outputPreview));
}

function pushBounded(arr, item, max) {
  arr.push(item);
  while (arr.length > max) arr.shift();
}

function tripCount(arr, key) {
  let n = 0;
  for (const v of arr) if (v === key) n++;
  return n;
}

// --- Supervisor (event-level) ----------------------------------------------

export class Supervisor {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /**
   * Observe one event. Returns { action: 'ok' | 'trip', reason, autoCancelOk? }.
   * `autoCancelOk: false` means the daemon should NOT cancel the upstream ACP
   * session on trip — the bridge should surface partial output instead. Used
   * for loop trips where cancelling would kill recoverable context.
   */
  observe(event, state) {
    const c = ensureCounters(state);
    const now = event.ts || Date.now();

    // 1. Failure streaks — per-tool. 3 failures of the SAME tool trips;
    //    mixed failures across different tools don't (flaky web_search
    //    bursts shouldn't kill a multi-tool research session).
    if (event.type === 'tool_call_update' && event.status === 'failed') {
      const key = toolKey(event);
      c.failuresByTool[key] = (c.failuresByTool[key] || 0) + 1;
      const n = c.failuresByTool[key];
      if (n >= this.opts.failuresLimit) {
        const preview = typeof event.outputPreview === 'string'
          ? event.outputPreview.slice(0, 120)
          : '';
        return {
          action: 'trip',
          reason: `failures:${n}_failed_tool_calls:${key}`,
          detail: preview ? `err="${preview}"` : undefined,
        };
      }
    } else if (event.type === 'tool_call_update' && event.status === 'completed') {
      const key = toolKey(event);
      c.failuresByTool[key] = 0;
    }

    // 2. View-specific loop detection (more permissive than generic tool_call
    //    hash detection; paginated reads must not trip)
    if (isViewEvent(event)) {
      const vkey = viewExactKey(event);
      pushBounded(c.recentViewExacts, vkey, this.opts.recentViewWindow);
      if (tripCount(c.recentViewExacts, vkey) >= this.opts.recentViewTrip) {
        return { action: 'trip', reason: `loop:identical_view:${vkey}`, autoCancelOk: false };
      }
    }

    // 3. Generic tool_call hash loop (non-view)
    if (event.type === 'tool_call' && !isViewEvent(event)) {
      const key = hashToolCall(event);
      pushBounded(c.recentToolCallHashes, key, this.opts.recentToolCallWindow);
      if (tripCount(c.recentToolCallHashes, key) >= this.opts.recentToolCallTrip) {
        return { action: 'trip', reason: `loop:identical_tool_call:${(event.name || '').slice(0, 80)}`, autoCancelOk: false };
      }
    }

    // 4. Negative output previews — trip only on a concentrated burst of
    //    negatives (N inside the last M tool_call_updates-with-preview), not
    //    ordinary successful search misses during exploration.
    if (event.type === 'tool_call_update' && typeof event.outputPreview === 'string') {
      if (isBenignReadMiss(event)) return { action: 'ok', reason: null };
      let isNegative = false;
      for (const re of NEGATIVE_PREVIEW_PATTERNS) {
        if (re.test(event.outputPreview)) { isNegative = true; break; }
      }
      pushBounded(c.recentOutputNegatives, isNegative, this.opts.outputNegativeWindow);
      const negCount = c.recentOutputNegatives.reduce((n, v) => n + (v ? 1 : 0), 0);
      if (negCount >= this.opts.outputNegativeTrip) {
        return { action: 'trip', reason: `negatives:${negCount}_of_${c.recentOutputNegatives.length}_recent_previews` };
      }
    }

    // No tool-calls-without-message cap — see DEFAULTS comment.
    // Hung-tool detection lives at the poll level (silenceTripMs): an
    // individually pending tool_call is only a problem if the whole prompt
    // is silent, which pollSupervisor already catches. A per-tool age check
    // here false-positived on legitimately long tools (task sub-agent spawn,
    // web_search, bash) while sibling events were still flowing.

    return { action: 'ok', reason: null };
  }
}

// --- pollSupervisor (poll-level, tiered) -----------------------------------

/**
 * Tier-aware silence/age check. Called by the daemon's setInterval.
 *
 * @param {object} state - inFlightPrompts entry; needs { lastEventAt, startedAt, _hasFirstRealEvent?, _lastAlertTs? }
 * @param {number} [nowMs=Date.now()]
 * @param {object} [opts] - any DEFAULTS key to override
 * @returns {{action: 'ok' | 'alert' | 'trip', reason: string | null, tier: 1 | 2 | null}}
 */
export function pollSupervisor(state, nowMs = Date.now(), opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const idle = nowMs - state.lastEventAt;
  const age = nowMs - (state.startedAt ?? state.lastEventAt);
  const hasMadeProgress = state._hasFirstRealEvent === true;

  const tripThreshold = hasMadeProgress ? o.silenceTripMs : o.firstEventSilenceTripMs;
  const alertThreshold = hasMadeProgress ? o.silenceAlertMs : o.firstEventSilenceAlertMs;

  // Tier 2 — silence trip (cancel). Checked BEFORE alert so a prompt that has
  // been silent long enough to trip doesn't get downgraded to an alert.
  if (idle > tripThreshold) {
    const tag = hasMadeProgress ? '' : ':first_event';
    return { action: 'trip', reason: `silence:${Math.round(idle / 1000)}s${tag}`, tier: 2 };
  }

  // Tier 1 — idle alert, subject to per-prompt cooldown.
  if (idle > alertThreshold) {
    if (withinCooldown(state, nowMs, o.alertCooldownMs)) {
      return { action: 'ok', reason: null, tier: null };
    }
    const tag = hasMadeProgress ? '' : ':first_event';
    return { action: 'alert', reason: `silence:${Math.round(idle / 1000)}s${tag}`, tier: 1 };
  }

  // Tier 1 — age alert (prompt making progress but running a long time).
  if (age > o.ageAlertMs) {
    if (withinCooldown(state, nowMs, o.alertCooldownMs)) {
      return { action: 'ok', reason: null, tier: null };
    }
    return { action: 'alert', reason: `age:${Math.round(age / 1000)}s`, tier: 1 };
  }

  return { action: 'ok', reason: null, tier: null };
}

function withinCooldown(state, nowMs, cooldownMs) {
  return state._lastAlertTs != null && nowMs - state._lastAlertTs < cooldownMs;
}
