// resolveRouting — the sole SEND routing brain. Table-driven coverage of every
// {target, profile, strength} combination plus the committed migration
// regressions (golden byte-identical job, opencode CLI model in spawn args,
// sid namespacing). Sandboxed via AGENT_COMPANION_HOME.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const SANDBOX = mkdtempSync(join(tmpdir(), 'routing-state-'));
process.env.AGENT_COMPANION_HOME = SANDBOX;
const TEST_CWD = tmpdir();
const SERVER_SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'server.mjs'), 'utf8');

// Acceptance: resolveRouting is the SOLE SEND routing brain. The old one-to-one
// resolveTargetId chokepoint is gone, and handleSend resolves routing only via
// resolveRouting — never bypassing it with a direct getTarget/normalizeTargetId
// call for the send decision.
test('ACCEPTANCE: handleSend routes only through resolveRouting (no bypass)', () => {
  assert.ok(!/function resolveTargetId\b/.test(SERVER_SRC), 'resolveTargetId chokepoint must be removed');
  const m = SERVER_SRC.match(/async function handleSend\(args\) \{[\s\S]*?\n\}\n/);
  assert.ok(m, 'handleSend not found');
  const body = m[0];
  assert.ok(body.includes('resolveRouting('), 'handleSend must call resolveRouting');
  assert.ok(!body.includes('getTarget('), 'handleSend must not call getTarget directly');
  assert.ok(!body.includes('normalizeTargetId('), 'handleSend must not call normalizeTargetId directly');
  assert.ok(!body.includes('resolveTargetId('), 'handleSend must not call resolveTargetId');
});

// Guards the profileId-threading regression: any function that retires a thread
// sid by profile must have profileId in scope (emitWorkerFailure had a bare
// `profileId` reference with no binding → ReferenceError on the empty-completed
// reconcile path).
test('ACCEPTANCE: every retireThreadSid caller has profileId in scope', () => {
  const fns = SERVER_SRC.match(/(?:async )?function \w+\([\s\S]*?\n\}\n/g) || [];
  for (const fn of fns) {
    if (!fn.includes('retireThreadSid(thread, profileId') && !fn.includes('retireThreadSid(job.thread, job.profileId')) continue;
    const declares = /\bprofileId\b/.test(fn.split('\n')[0]) // param
      || /const profileId =/.test(fn)
      || fn.includes('retireThreadSid(job.thread, job.profileId'); // reads off the job
    assert.ok(declares, `a function retires a thread sid but never binds profileId:\n${fn.slice(0, 120)}`);
  }
});

const state = await import('../lib/state.mjs');
const server = await import('./server.mjs');
const { resolveRouting } = server;

test.after(() => rmSync(SANDBOX, { recursive: true, force: true }));

function setProfiles(doc) { state.writeProfiles(doc); }
function reset() {
  state.clearProfiles();
  state.clearDefaultTarget();
  state.clearDefaultModel();
}

const COPILOT_ENV = { AGENT_COMPANION_DEFAULT_TARGET: 'copilot' };

// ---- 0-input / synthesis -----------------------------------------------------

test('0 inputs with default-target copilot synthesizes (companion copilot, profileId null)', () => {
  reset();
  const r = resolveRouting({}, COPILOT_ENV);
  assert.equal(r.ok, true);
  assert.equal(r.resolved.companion, 'copilot');
  assert.equal(r.resolved.profileId, null);
  assert.equal(r.resolved.synthesized, true);
  assert.equal(r.resolved.model, 'claude-sonnet-4.6'); // default-model fallback
});

test('0 inputs with nothing configured → TARGET_UNCONFIGURED', () => {
  reset();
  const r = resolveRouting({}, {});
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TARGET_UNCONFIGURED');
});

// ---- profile-only ------------------------------------------------------------

test('profile-only resolves; unknown profile → PROFILE_UNKNOWN echoing candidates', () => {
  reset();
  setProfiles({ profiles: [
    { id: 'cop-review', companion: 'copilot', model: 'claude-sonnet-4.6', strengths: ['reviewer'] },
  ] });
  const ok = resolveRouting({ profile: 'cop-review' }, {});
  assert.equal(ok.ok, true);
  assert.equal(ok.resolved.profileId, 'cop-review');
  assert.equal(ok.resolved.companion, 'copilot');
  assert.equal(ok.resolved.model, 'claude-sonnet-4.6');

  const bad = resolveRouting({ profile: 'ghost' }, {});
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'PROFILE_UNKNOWN');
  assert.deepEqual(bad.candidates, ['cop-review']);
});

// ---- strength-only -----------------------------------------------------------

test('strength-only cardinality 0/1/N', () => {
  reset();
  setProfiles({ profiles: [
    { id: 'cop-review', companion: 'copilot', strengths: ['reviewer'] },
    { id: 'cop-plan-a', companion: 'copilot', strengths: ['planner'] },
    { id: 'cop-plan-b', companion: 'copilot', strengths: ['planner'] },
  ] });
  const one = resolveRouting({ strength: 'reviewer' }, {});
  assert.equal(one.ok, true);
  assert.equal(one.resolved.profileId, 'cop-review');
  assert.equal(one.resolved.strength, 'reviewer');

  const none = resolveRouting({ strength: 'web_researcher' }, {});
  assert.equal(none.ok, false);
  assert.equal(none.code, 'STRENGTH_UNCONFIGURED');

  const ambiguous = resolveRouting({ strength: 'planner' }, {});
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.code, 'STRENGTH_AMBIGUOUS');
  assert.deepEqual(ambiguous.candidates, ['cop-plan-a', 'cop-plan-b']);
});

test('defaultProfile that claims the ambiguous strength wins the tiebreak', () => {
  reset();
  setProfiles({
    profiles: [
      { id: 'cop-plan-a', companion: 'copilot', strengths: ['planner'] },
      { id: 'cop-plan-b', companion: 'copilot', strengths: ['planner'] },
    ],
    defaultProfile: 'cop-plan-b',
  });
  const r = resolveRouting({ strength: 'planner' }, {});
  assert.equal(r.ok, true);
  assert.equal(r.resolved.profileId, 'cop-plan-b');
});

// ---- mutual exclusion + refinement ------------------------------------------

test('profile + strength → ROUTING_CONFLICT', () => {
  reset();
  setProfiles({ profiles: [{ id: 'cop-review', companion: 'copilot', strengths: ['reviewer'] }] });
  const r = resolveRouting({ profile: 'cop-review', strength: 'reviewer' }, {});
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ROUTING_CONFLICT');
});

test('target refinement: matching target OK, mismatched target → ROUTING_CONFLICT', () => {
  reset();
  setProfiles({ profiles: [
    { id: 'cop-review', companion: 'copilot', strengths: ['reviewer'] },
    { id: 'oc-web', companion: 'opencode', adapter: 'server', strengths: ['web_researcher'] },
  ] });
  const ok = resolveRouting({ strength: 'reviewer', target: 'copilot' }, {});
  assert.equal(ok.ok, true);
  assert.equal(ok.resolved.companion, 'copilot');

  const conflict = resolveRouting({ strength: 'reviewer', target: 'opencode' }, {});
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'ROUTING_CONFLICT');

  const profConflict = resolveRouting({ profile: 'oc-web', target: 'copilot' }, {});
  assert.equal(profConflict.ok, false);
  assert.equal(profConflict.code, 'ROUTING_CONFLICT');
});

// ---- bare target -------------------------------------------------------------

test('bare target picks the lone matching profile; ambiguous without tiebreak → PROFILE_AMBIGUOUS', () => {
  reset();
  setProfiles({ profiles: [
    { id: 'cop-a', companion: 'copilot', strengths: [] },
    { id: 'cop-b', companion: 'copilot', strengths: [] },
    { id: 'oc-only', companion: 'opencode', strengths: [] },
  ] });
  const oc = resolveRouting({ target: 'opencode' }, {});
  assert.equal(oc.ok, true);
  assert.equal(oc.resolved.profileId, 'oc-only');

  const amb = resolveRouting({ target: 'copilot' }, {});
  assert.equal(amb.ok, false);
  assert.equal(amb.code, 'PROFILE_AMBIGUOUS');
  assert.deepEqual(amb.candidates.sort(), ['cop-a', 'cop-b']);
});

test('empty/no-default edge: valid profiles + no defaultProfile + default-target falls back to bare-target', () => {
  reset();
  setProfiles({ profiles: [{ id: 'oc-web', companion: 'opencode', strengths: ['web_researcher'] }] });
  // 0 inputs, no defaultProfile, but default-target=opencode (env) → bare opencode
  const r = resolveRouting({}, { AGENT_COMPANION_DEFAULT_TARGET: 'opencode' });
  assert.equal(r.ok, true);
  assert.equal(r.resolved.companion, 'opencode');
  assert.equal(r.resolved.profileId, 'oc-web'); // the lone opencode profile
});

test('all-invalid registry + default-target still resolves via legacy bare-target', () => {
  reset();
  setProfiles({ profiles: [{ id: 'BAD' }, { companion: 'copilot' }] }); // all dropped
  const r = resolveRouting({}, COPILOT_ENV);
  assert.equal(r.ok, true);
  assert.equal(r.resolved.companion, 'copilot');
  assert.equal(r.resolved.profileId, null); // synthesized for the bare target
});

test('a defaultProfile naming no configured profile fails loud on a no-arg send (no silent fallback)', () => {
  reset();
  // Valid profile present, but defaultProfile is a typo. A no-arg send must NOT
  // silently degrade to default-target/TARGET_UNCONFIGURED — it echoes candidates.
  setProfiles({ profiles: [{ id: 'cop-review', companion: 'copilot', strengths: ['reviewer'] }], defaultProfile: 'ghost' });
  const r = resolveRouting({}, COPILOT_ENV);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PROFILE_UNKNOWN');
  assert.deepEqual(r.candidates, ['cop-review']);
});

// ---- capability gate ---------------------------------------------------------

test('copilot profile with a non-Copilot model → MODEL_NOT_ALLOWED (legacy reason kept)', () => {
  reset();
  setProfiles({ profiles: [{ id: 'cop-bad', companion: 'copilot', model: 'gpt-5.5', strengths: [] }] });
  const r = resolveRouting({ profile: 'cop-bad' }, {});
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MODEL_NOT_ALLOWED');
  assert.equal(r.companion, 'copilot');
  assert.equal(r.model, 'gpt-5.5');
});

test('opencode profile with a malformed model → CAPABILITY_UNAVAILABLE', () => {
  reset();
  setProfiles({ profiles: [{ id: 'oc-bad', companion: 'opencode', model: 'no-slash', strengths: [] }] });
  const r = resolveRouting({ profile: 'oc-bad' }, {});
  assert.equal(r.ok, false);
  assert.equal(r.code, 'CAPABILITY_UNAVAILABLE');
});

test('opencode adapter:server profile inherits reply/resume capabilities', () => {
  reset();
  setProfiles({ profiles: [{ id: 'oc-srv', companion: 'opencode', adapter: 'server', model: 'anthropic/claude-sonnet-4.6', strengths: ['web_researcher'] }] });
  const r = resolveRouting({ profile: 'oc-srv' }, {});
  assert.equal(r.ok, true);
  assert.equal(r.resolved.adapter, 'server');
  assert.equal(r.resolved.capabilities.reply, true);
  assert.equal(r.resolved.capabilities.resume, true);
});

// Codex's model gate is PERMISSIVE (isModelAllowedFor('codex', m) accepts any
// non-blank id — codex ids are bare, no mandatory slash, and the catalog
// churns too fast for a curated set). There is therefore no
// MODEL_NOT_ALLOWED/CAPABILITY_UNAVAILABLE path to assert for a valid codex
// model id — only that the gate does NOT reject it.
test('codex profile with an arbitrary model resolves (permissive gate, no curated catalog)', () => {
  reset();
  setProfiles({ profiles: [{ id: 'cx-sol', companion: 'codex', model: 'gpt-5.6-sol', strengths: [] }] });
  const r = resolveRouting({ profile: 'cx-sol' }, {});
  assert.equal(r.ok, true);
  assert.equal(r.resolved.companion, 'codex');
  assert.equal(r.resolved.model, 'gpt-5.6-sol');
});

// ---- codex bare target / target refinement -----------------------------------

test('bare codex target picks the lone matching profile; ambiguous without tiebreak → PROFILE_AMBIGUOUS', () => {
  reset();
  setProfiles({ profiles: [
    { id: 'cx-a', companion: 'codex', strengths: [] },
    { id: 'cx-b', companion: 'codex', strengths: [] },
    { id: 'cop-only', companion: 'copilot', strengths: [] },
  ] });
  const cop = resolveRouting({ target: 'copilot' }, {});
  assert.equal(cop.ok, true);
  assert.equal(cop.resolved.profileId, 'cop-only');

  const amb = resolveRouting({ target: 'codex' }, {});
  assert.equal(amb.ok, false);
  assert.equal(amb.code, 'PROFILE_AMBIGUOUS');
  assert.deepEqual(amb.candidates.sort(), ['cx-a', 'cx-b']);
});

test('target refinement: codex matches its own strength but conflicts with a different explicit target', () => {
  reset();
  setProfiles({ profiles: [{ id: 'cx-fast', companion: 'codex', strengths: ['fast_executor'] }] });
  const ok = resolveRouting({ strength: 'fast_executor', target: 'codex' }, {});
  assert.equal(ok.ok, true);
  assert.equal(ok.resolved.companion, 'codex');

  const conflict = resolveRouting({ strength: 'fast_executor', target: 'opencode' }, {});
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'ROUTING_CONFLICT');
});

// ---- committed regressions ---------------------------------------------------

test('P4 status: always-on id-free strengths[], diagnostics-gated profiles[], no leakage', async () => {
  reset();
  const { dispatch, _resetForTest } = server;
  _resetForTest();
  setProfiles({ profiles: [
    { id: 'cop-review', companion: 'copilot', model: 'claude-sonnet-4.6', strengths: ['reviewer'] },
    { id: 'cop-plan-a', companion: 'copilot', strengths: ['planner'] },
    { id: 'cop-plan-b', companion: 'copilot', strengths: ['planner'] },
    { id: 'oc-web', companion: 'opencode', adapter: 'server', model: 'anthropic/claude-sonnet-4.6', strengths: ['web_researcher'] },
  ], defaultProfile: 'cop-review' });
  try {
    const status = JSON.parse((await dispatch({ action: 'status' })).content[0].text);
    // Always-on flat strengths[] with {name, ready, reason}.
    const byName = Object.fromEntries(status.strengths.map((s) => [s.name, s]));
    assert.deepEqual(Object.keys(byName).sort(), ['fast_executor', 'planner', 'reviewer', 'web_researcher']);
    assert.equal(byName.reviewer.ready, true);
    assert.equal(byName.reviewer.reason, null);
    assert.equal(byName.web_researcher.ready, true);
    assert.equal(byName.planner.ready, false); // ambiguous, defaultProfile claims reviewer not planner
    assert.equal(byName.fast_executor.ready, false);
    // default_profile is surfaced beside default_target.
    assert.equal(status.default_profile.value, 'cop-review');

    // Whole strengths payload (every field, incl. reason) is id-free.
    const blob = JSON.stringify(status.strengths);
    for (const id of ['cop-review', 'cop-plan-a', 'cop-plan-b', 'oc-web', 'copilot', 'opencode', 'claude-sonnet-4.6', 'anthropic']) {
      assert.ok(!blob.includes(id), `strengths payload leaks "${id}": ${blob}`);
    }

    // profiles[] is NOT present without diagnostics, and NOT gated by verbose.
    assert.equal(status.profiles, undefined);
    const verbose = JSON.parse((await dispatch({ action: 'status', verbose: true })).content[0].text);
    assert.equal(verbose.profiles, undefined);

    // profiles[] IS present (with ids + blockers) under diagnostics:true.
    const diag = JSON.parse((await dispatch({ action: 'status', diagnostics: true })).content[0].text);
    assert.ok(Array.isArray(diag.profiles));
    assert.deepEqual(diag.profiles.map((p) => p.id).sort(), ['cop-plan-a', 'cop-plan-b', 'cop-review', 'oc-web']);
    assert.ok(diag.profiles.every((p) => 'ready' in p && Array.isArray(p.blockers)));
  } finally {
    state.clearProfiles();
  }
});

test('REGRESSION golden: synthesized bare send keeps profileId null and writes the legacy <thread>.sid', async () => {
  reset();
  const { dispatch, jobs, _resetForTest } = server;
  _resetForTest();
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-golden';
  state.writeDefaultTarget('copilot');
  state.clearThread('golden-thread');
  const { _setForTest, _resetForTest: resetDaemon } = await import('./daemon-client.mjs');
  _setForTest({
    ensureDaemon: async () => {},
    sendToSocket: async (msg) => {
      if (msg.command === 'prompt-bg') return { ok: true, data: { promptId: 'p-golden', sessionId: 'ses-golden' } };
      if (msg.command === 'watch') return { ok: true, data: { status: 'completed', summary: { message: 'done.\n\nRUBBER-DUCK: clean.' } } };
      return { ok: true, data: {} };
    },
  });
  try {
    const send = JSON.parse((await dispatch({
      action: 'send', task: 'golden', mode: 'EXECUTE', template: 'general',
      thread: 'golden-thread', cwd: TEST_CWD, host_session_id: 'sid-golden',
      max_wait_sec: 5, parallel: 'never',
    })).content[0].text);
    assert.equal(send.target, 'copilot');
    assert.match(send.job_id, /^copilot-/);
    assert.equal(send.profile, null);
    const job = jobs.get(send.job_id);
    assert.equal(job.profileId, null);
    assert.equal(job.model, 'claude-sonnet-4.6');
    for (let i = 0; i < 60 && !jobs.get(send.job_id)?.terminalAt; i++) await new Promise((r) => setImmediate(r));
    // Legacy sid filename (no __profile suffix) — byte-identical to pre-#2.
    assert.ok(existsSync(join(SANDBOX, 'threads', 'golden-thread.sid')));
    assert.ok(!existsSync(join(SANDBOX, 'threads', 'golden-thread____default__.sid')));
  } finally {
    resetDaemon();
    for (const id of [...jobs.keys()]) if (jobs.get(id)?.claudeSessionId === 'sid-golden') jobs.delete(id);
    state.clearThread('golden-thread'); state.clearProfiles(); state.clearDefaultTarget();
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
  }
});

test('REGRESSION sid-namespace: two profiles on the same thread write distinct sid files', async () => {
  reset();
  const { dispatch, jobs, _resetForTest } = server;
  _resetForTest();
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-ns';
  setProfiles({ profiles: [
    { id: 'cop-review', companion: 'copilot', model: 'claude-sonnet-4.6', strengths: ['reviewer'] },
    { id: 'cop-fast', companion: 'copilot', model: 'claude-haiku-4.5', strengths: ['fast_executor'] },
  ] });
  const { _setForTest, _resetForTest: resetDaemon } = await import('./daemon-client.mjs');
  // Capture the sid the worker persists by faking the daemon's prompt to return a sessionId.
  _setForTest({
    ensureDaemon: async () => {},
    sendToSocket: async (msg) => {
      if (msg?.type === 'prompt-bg' || msg?.cmd === 'prompt-bg') {
        return { ok: true, data: { promptId: 'p-' + Math.random().toString(36).slice(2), sessionId: 'ses-' + Math.random().toString(36).slice(2) } };
      }
      return { ok: true, data: {} };
    },
  });
  try {
    for (const [profile, sid] of [['cop-review', 'review'], ['cop-fast', 'fast']]) {
      // Pre-seed the sid file the worker would write, namespaced by profile.
      state.writeThreadSid('shared-ns', profile, `ses-${sid}`);
    }
    assert.equal(state.readThreadSid('shared-ns', 'cop-review'), 'ses-review');
    assert.equal(state.readThreadSid('shared-ns', 'cop-fast'), 'ses-fast');
    assert.ok(existsSync(join(SANDBOX, 'threads', 'shared-ns__cop-review.sid')));
    assert.ok(existsSync(join(SANDBOX, 'threads', 'shared-ns__cop-fast.sid')));
    // No cross-read: the legacy unqualified file is absent.
    assert.ok(!existsSync(join(SANDBOX, 'threads', 'shared-ns.sid')));
  } finally {
    resetDaemon();
    for (const id of [...jobs.keys()]) if (jobs.get(id)?.claudeSessionId === 'sid-ns') jobs.delete(id);
    state.clearThread('shared-ns', 'cop-review');
    state.clearThread('shared-ns', 'cop-fast');
    state.clearProfiles();
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
  }
});

test('REGRESSION copilot daemon model: a profile model reaches the daemon prompt-bg message', async () => {
  reset();
  const { dispatch, jobs, _resetForTest } = server;
  _resetForTest();
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-copmodel';
  // A non-default but allowed Copilot model (default-model fallback is claude-sonnet-4.6).
  setProfiles({ profiles: [{ id: 'cop-haiku', companion: 'copilot', model: 'claude-haiku-4.5', strengths: ['fast_executor'] }] });
  const { _setForTest, _resetForTest: resetDaemon } = await import('./daemon-client.mjs');
  let promptModel = 'UNSET';
  _setForTest({
    ensureDaemon: async () => {},
    sendToSocket: async (msg) => {
      if (msg.command === 'prompt-bg') { promptModel = msg.model; return { ok: true, data: { promptId: 'p-cm', sessionId: 'ses-cm' } }; }
      if (msg.command === 'watch') return { ok: true, data: { status: 'completed', summary: { message: 'done.\n\nRUBBER-DUCK: clean.' } } };
      return { ok: true, data: {} };
    },
  });
  try {
    const send = JSON.parse((await dispatch({
      action: 'send', strength: 'fast_executor', task: 'fast', mode: 'EXECUTE', template: 'general',
      cwd: TEST_CWD, host_session_id: 'sid-copmodel', max_wait_sec: 5, parallel: 'never',
    })).content[0].text);
    assert.equal(send.ok, true);
    assert.equal(send.target, 'copilot');
    assert.equal(send.profile, 'cop-haiku');
    for (let i = 0; i < 60 && !jobs.get(send.job_id)?.terminalAt; i++) await new Promise((r) => setImmediate(r));
    // The per-profile model — not the default-model — reaches the daemon spawn.
    assert.equal(promptModel, 'claude-haiku-4.5');
  } finally {
    resetDaemon();
    for (const id of [...jobs.keys()]) if (jobs.get(id)?.claudeSessionId === 'sid-copmodel') jobs.delete(id);
    state.clearProfiles();
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
  }
});

test('P4 status strengths[] stays id-free with a codex profile in the mix', async () => {
  reset();
  const { dispatch, _resetForTest } = server;
  _resetForTest();
  setProfiles({ profiles: [{ id: 'cx-review', companion: 'codex', model: 'gpt-5.6-sol', strengths: ['reviewer'] }] });
  try {
    const status = JSON.parse((await dispatch({ action: 'status' })).content[0].text);
    const byName = Object.fromEntries(status.strengths.map((s) => [s.name, s]));
    assert.equal(byName.reviewer.ready, true);
    const blob = JSON.stringify(status.strengths);
    for (const id of ['cx-review', 'codex', 'gpt-5.6-sol']) {
      assert.ok(!blob.includes(id), `strengths payload leaks "${id}": ${blob}`);
    }
  } finally {
    state.clearProfiles();
  }
});

test('REGRESSION codex model: a profile model reaches `codex exec -m` spawn args', async () => {
  reset();
  const { dispatch, jobs, _resetForTest } = server;
  _resetForTest();
  const tmp = mkdtempSync(join(tmpdir(), 'codex-model-fake-'));
  const argvFile = join(tmp, 'argv.json');
  const fakeBin = join(tmp, 'codex-fake.mjs');
  writeFileSync(fakeBin, [
    '#!/usr/bin/env node',
    'import { writeFileSync } from "node:fs";',
    'const args = process.argv.slice(2);',
    `writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(args));`,
    'console.log(JSON.stringify({ type: "thread.started", thread_id: "th-model-test" }));',
    'console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }));',
    'console.log(JSON.stringify({ type: "turn.completed", usage: {} }));',
    '',
  ].join('\n'), { mode: 0o700 });
  chmodSync(fakeBin, 0o700);
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  const oldBin = process.env.CODEX_BIN;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-cxmodel';
  process.env.CODEX_BIN = fakeBin;
  setProfiles({ profiles: [{ id: 'cx-pin', companion: 'codex', model: 'gpt-5.6-sol', strengths: [] }] });
  try {
    const send = JSON.parse((await dispatch({
      action: 'send', profile: 'cx-pin', task: 'pin the model', mode: 'EXECUTE', template: 'general',
      cwd: TEST_CWD, host_session_id: 'sid-cxmodel', max_wait_sec: 5, parallel: 'never',
    })).content[0].text);
    assert.equal(send.ok, true);
    assert.equal(send.target, 'codex');
    JSON.parse((await dispatch({ action: 'wait', job_id: send.job_id, host_session_id: 'sid-cxmodel', max_wait_sec: 5 })).content[0].text);
    const args = JSON.parse(readFileSync(argvFile, 'utf8'));
    const i = args.indexOf('-m');
    assert.ok(i >= 0, `-m not in args: ${args.join(' ')}`);
    assert.equal(args[i + 1], 'gpt-5.6-sol');
  } finally {
    for (const id of [...jobs.keys()]) if (jobs.get(id)?.claudeSessionId === 'sid-cxmodel') jobs.delete(id);
    state.clearProfiles();
    rmSync(tmp, { recursive: true, force: true });
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    if (oldBin === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = oldBin;
  }
});

test('REGRESSION opencode CLI model: a profile model reaches `opencode run --model` spawn args', async () => {
  reset();
  const { dispatch, jobs, _resetForTest } = server;
  _resetForTest();
  const tmp = mkdtempSync(join(tmpdir(), 'opencode-model-fake-'));
  const argvFile = join(tmp, 'argv.json');
  const fakeBin = join(tmp, 'opencode-fake.mjs');
  writeFileSync(fakeBin, [
    '#!/usr/bin/env node',
    'import { writeFileSync } from "node:fs";',
    'const args = process.argv.slice(2);',
    `writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(args));`,
    'console.log(JSON.stringify({ type: "message", message: "ok" }));',
    '',
  ].join('\n'), { mode: 0o700 });
  chmodSync(fakeBin, 0o700);
  const oldS = process.env.CLAUDE_CODE_SESSION_ID;
  const oldBin = process.env.OPENCODE_BIN;
  process.env.CLAUDE_CODE_SESSION_ID = 'sid-ocmodel';
  process.env.OPENCODE_BIN = fakeBin;
  setProfiles({ profiles: [{ id: 'oc-pin', companion: 'opencode', model: 'anthropic/claude-sonnet-4.6', strengths: [] }] });
  try {
    const send = JSON.parse((await dispatch({
      action: 'send', profile: 'oc-pin', task: 'pin the model', mode: 'EXECUTE', template: 'general',
      cwd: TEST_CWD, host_session_id: 'sid-ocmodel', max_wait_sec: 5, parallel: 'never',
    })).content[0].text);
    assert.equal(send.ok, true);
    assert.equal(send.target, 'opencode');
    JSON.parse((await dispatch({ action: 'wait', job_id: send.job_id, host_session_id: 'sid-ocmodel', max_wait_sec: 5 })).content[0].text);
    const args = JSON.parse(readFileSync(argvFile, 'utf8'));
    const i = args.indexOf('--model');
    assert.ok(i >= 0, `--model not in args: ${args.join(' ')}`);
    assert.equal(args[i + 1], 'anthropic/claude-sonnet-4.6');
  } finally {
    for (const id of [...jobs.keys()]) if (jobs.get(id)?.claudeSessionId === 'sid-ocmodel') jobs.delete(id);
    state.clearProfiles();
    rmSync(tmp, { recursive: true, force: true });
    if (oldS === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldS;
    if (oldBin === undefined) delete process.env.OPENCODE_BIN; else process.env.OPENCODE_BIN = oldBin;
  }
});
