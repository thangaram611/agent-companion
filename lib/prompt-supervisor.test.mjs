// Unit tests for prompt-supervisor.mjs
// Run: node --test ~/.claude/agent-companion/lib/prompt-supervisor.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Supervisor, pollSupervisor, DEFAULTS } from './prompt-supervisor.mjs';

// Non-zero base timestamp so `event.ts || Date.now()` in observe doesn't fall
// back to wall clock when we pass ts:0.
const T0 = 1_000_000;

function freshState() {
  return { lastEventAt: T0, startedAt: T0 };
}

function viewEvent(path, opts = {}) {
  return {
    type: 'tool_call',
    toolCallId: opts.toolCallId || 'tc_' + Math.random().toString(36).slice(2),
    name: opts.name || 'view ' + path,
    kind: opts.kind || 'read',
    input: { path, ...(opts.input || {}) },
    ts: opts.ts || T0,
  };
}

test('observe distinguishes safe high-volume activity from real tool-call loops', () => {
  for (const inputKind of ['view_range', 'line_limit']) {
    const sup = new Supervisor();
    const state = freshState();
    for (let i = 0; i < 6; i++) {
      const input = inputKind === 'view_range'
        ? { view_range: [i * 100 + 1, (i + 1) * 100] }
        : { line: i * 50 + 1, limit: 50 };
      const r = sup.observe(viewEvent('/some/file.mjs', { input, ts: T0 + i }), state);
      assert.equal(r.action, 'ok', `${inputKind} page ${i + 1} should not trip`);
    }
  }

  {
    const sup = new Supervisor();
    const state = freshState();
    for (let i = 0; i < 8; i++) {
      const r = sup.observe({
        type: 'tool_call',
        toolCallId: 'grep_' + i,
        name: `Searching for 'foo${i}'`,
        kind: 'read',
        input: { pattern: `foo${i}`, glob: '**/*.ts' },
        ts: T0 + i,
      }, state);
      assert.equal(r.action, 'ok', `grep #${i + 1} should not trip view loop`);
    }
  }

  {
    const sup = new Supervisor();
    const state = freshState();
    for (let i = 0; i < 500; i++) {
      const r = sup.observe({
        type: 'tool_call', toolCallId: 't_' + i,
        name: `distinct_${i}`, kind: 'read', input: { path: `/f_${i}` }, ts: T0 + i,
      }, state);
      assert.equal(r.action, 'ok', `distinct event ${i + 1} should not trip`);
    }
  }

  {
    const sup = new Supervisor();
    const state = freshState();
    sup.observe({ type: 'tool_call', toolCallId: 'tc_task', name: 'task', input: { prompt: 'research X' }, ts: T0 }, state);
    for (let i = 0; i < 30; i++) {
      assert.equal(sup.observe({ type: 'thought', text: `tick ${i}`, ts: T0 + i * 10_000 }, state).action, 'ok');
    }
    assert.equal(sup.observe({ type: 'thought', text: 'still going', ts: T0 + 300_000 }, state).action, 'ok');
  }

  {
    const sup = new Supervisor();
    const state = freshState();
    let r;
    let stuckAt = -1;
    for (let i = 0; i < 8; i++) {
      r = sup.observe(viewEvent('/x.mjs', { input: { view_range: [1, 100] }, ts: T0 + i }), state);
      if (r.action === 'trip') { stuckAt = i + 1; break; }
    }
    assert.equal(stuckAt, 6);
    assert.match(r.reason, /^loop:identical_view:/);
    assert.equal(r.autoCancelOk, false);
  }

  {
    const sup = new Supervisor();
    const state = freshState();
    const ev = { type: 'tool_call', name: 'shell', kind: 'shell', input: { cmd: 'ls' }, ts: T0 };
    let r;
    for (let i = 0; i < 5; i++) {
      r = sup.observe({ ...ev, toolCallId: 'sh_' + i }, state);
      if (r.action === 'trip') break;
    }
    assert.equal(r.action, 'trip');
    assert.match(r.reason, /^loop:identical_tool_call:/);
    assert.equal(r.autoCancelOk, false);
  }
});

test('observe treats failed tools per-tool and negative previews as a bounded window', () => {
  {
    const sup = new Supervisor();
    const state = freshState();
    let r;
    for (let i = 0; i < 4; i++) {
      r = sup.observe({ type: 'tool_call_update', status: 'failed', name: 'web_search', ts: T0 + i }, state);
      if (r.action === 'trip') break;
    }
    assert.equal(r.action, 'trip');
    assert.match(r.reason, /^failures:\d+_failed_tool_calls:web_search$/);
  }

  {
    const sup = new Supervisor();
    const state = freshState();
    sup.observe({ type: 'tool_call_update', status: 'failed', name: 'web_search', ts: T0 }, state);
    sup.observe({ type: 'tool_call_update', status: 'failed', name: 'web_search', ts: T0 + 1 }, state);
    sup.observe({ type: 'tool_call_update', status: 'completed', name: 'web_search', ts: T0 + 2 }, state);
    assert.equal(sup.observe({ type: 'tool_call_update', status: 'failed', name: 'web_search', ts: T0 + 3 }, state).action, 'ok');
    assert.equal(sup.observe({ type: 'tool_call_update', status: 'failed', name: 'web_search', ts: T0 + 4 }, state).action, 'ok');
  }

  {
    const sup = new Supervisor();
    const state = freshState();
    for (const [name, ts] of [['web_search', T0], ['web_fetch', T0 + 1], ['grep', T0 + 2]]) {
      assert.equal(sup.observe({ type: 'tool_call_update', status: 'failed', name, ts }, state).action, 'ok');
    }
  }

  {
    const sup = new Supervisor();
    const state = freshState();
    sup.observe({ type: 'tool_call_update', status: 'failed', name: 'web_search', ts: T0 }, state);
    sup.observe({ type: 'tool_call_update', status: 'completed', name: 'grep', ts: T0 + 1 }, state);
    sup.observe({ type: 'tool_call_update', status: 'failed', name: 'web_search', ts: T0 + 2 }, state);
    sup.observe({ type: 'tool_call_update', status: 'completed', name: 'view', ts: T0 + 3 }, state);
    const r = sup.observe({ type: 'tool_call_update', status: 'failed', name: 'web_search', ts: T0 + 4 }, state);
    assert.equal(r.action, 'trip');
    assert.match(r.reason, /:web_search$/);
  }

  {
    const sup = new Supervisor();
    const state = freshState();
    let r;
    for (const preview of ['permission denied', 'no matches', 'not found']) {
      r = sup.observe({ type: 'tool_call_update', status: 'completed', outputPreview: preview, ts: T0 }, state);
      if (r.action === 'trip') break;
    }
    assert.equal(r.action, 'trip');
    assert.match(r.reason, /^negatives:\d+_of_\d+_recent_previews/);
  }

  {
    const sup = new Supervisor();
    const state = freshState();
    const benignMisses = [
      { name: "Searching for 'documentRoute|document.*[Rr...'", kind: 'read', outputPreview: 'No matches found.' },
      { name: "Searching for 'documentRoute|document.*[Rr...'", kind: 'read', outputPreview: 'No matches found.' },
      { name: "Searching for 'document'", kind: 'read', outputPreview: 'No matches found.' },
      { name: 'Finding files matching **/app.{ts,js}', kind: 'read', outputPreview: 'No files matched the pattern.' },
    ];
    for (const [i, miss] of benignMisses.entries()) {
      assert.equal(
        sup.observe({ type: 'tool_call_update', status: 'completed', ...miss, ts: T0 + i }, state).action,
        'ok',
        `successful read miss #${i + 1} should not trip`,
      );
    }
  }

  {
    const sup = new Supervisor();
    const state = freshState();
    const previews = [
      'no matches', 'ok', 'ok', 'ok', 'ok', 'ok',
      'not found', 'ok', 'ok', 'ok', 'ok', 'ok',
      'permission denied', 'ok', 'ok', 'ok', 'ok', 'ok',
    ];
    for (const preview of previews) {
      assert.equal(
        sup.observe({ type: 'tool_call_update', status: 'completed', outputPreview: preview, ts: T0 }, state).action,
        'ok',
        `scattered negative "${preview}" should not trip`,
      );
    }
  }
});

test('pollSupervisor applies idle, first-event, age, cooldown, and override thresholds', () => {
  const running = () => ({ lastEventAt: 0, startedAt: 0, _hasFirstRealEvent: true, _lastAlertTs: null });
  assert.deepEqual(
    { action: pollSupervisor(running(), 60_000).action, tier: pollSupervisor(running(), 60_000).tier },
    { action: 'ok', tier: null },
  );
  let r = pollSupervisor(running(), 150_000);
  assert.equal(r.action, 'alert');
  assert.equal(r.tier, 1);
  assert.match(r.reason, /^silence:\d+s$/);
  r = pollSupervisor(running(), 250_000);
  assert.equal(r.action, 'trip');
  assert.equal(r.tier, 2);
  assert.match(r.reason, /^silence:\d+s$/);
  assert.equal(pollSupervisor(running(), 241_000).tier, 2);

  const preFirst = () => ({ lastEventAt: 0, startedAt: 0, _hasFirstRealEvent: false, _lastAlertTs: null });
  assert.equal(pollSupervisor(preFirst(), 170_000).action, 'ok');
  r = pollSupervisor(preFirst(), 200_000);
  assert.equal(r.action, 'alert');
  assert.match(r.reason, /:first_event$/);
  r = pollSupervisor(preFirst(), 400_000);
  assert.equal(r.action, 'trip');
  assert.match(r.reason, /:first_event$/);

  const cooled = running();
  assert.equal(pollSupervisor(cooled, 150_000).action, 'alert');
  cooled._lastAlertTs = 150_000;
  assert.equal(pollSupervisor(cooled, 180_000).action, 'ok');
  assert.equal(pollSupervisor(cooled, 215_000).action, 'alert');

  const now = 400_000;
  r = pollSupervisor({ lastEventAt: now - 5_000, startedAt: 0, _hasFirstRealEvent: true, _lastAlertTs: null }, now);
  assert.equal(r.action, 'alert');
  assert.match(r.reason, /^age:\d+s$/);
  assert.equal(
    pollSupervisor({ lastEventAt: now - 5_000, startedAt: 0, _hasFirstRealEvent: true, _lastAlertTs: now - 30_000 }, now).action,
    'ok',
  );

  assert.equal(pollSupervisor(running(), 50_000, { silenceAlertMs: 30_000 }).action, 'alert');
});

test('DEFAULTS keep alert thresholds below trip thresholds and cooldown inside alert cadence', () => {
  assert.ok(DEFAULTS.silenceAlertMs < DEFAULTS.silenceTripMs);
  assert.ok(DEFAULTS.firstEventSilenceAlertMs < DEFAULTS.firstEventSilenceTripMs);
  assert.ok(DEFAULTS.alertCooldownMs <= DEFAULTS.silenceAlertMs);
});
