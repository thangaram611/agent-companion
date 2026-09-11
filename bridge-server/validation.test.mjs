// Validation tests for the single `copilot` tool. Pure-function:
// no sockets, no daemon, no state-layer side effects.

import '../test/sandbox-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  realpathSync,
  mkdirSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  validateAgentArgs,
  VALID_ACTIONS,
  VALID_MODES,
  VALID_TEMPLATES,
  VALID_TARGETS,
  DEFAULT_MODE,
  formatPrompt,
  appendRubberDuckReview,
  classifyReviewVerdict,
  RUBBER_DUCK_EXEMPT_TEMPLATES,
  shouldUseFleet,
} from './validation.mjs';

const TEST_CWD = tmpdir();

// `formatPrompt`'s plan_path=latest resolution logs, and the log path resolves
// through runtimeDir() at every call — so this pure-function suite appended to
// the operator's live ~/.claude/agent-companion/runtime log (measured 145 bytes
// per run). runtimeDir() itself is what gets pinned, the same knob every other
// suite uses, so a later test that writes a digest or a ledger row is already
// contained. Never unset: clearing the redirect is what re-points a straggler at
// the real path.
const RUNTIME_SANDBOX = mkdtempSync(join(tmpdir(), 'ac-rt-val-'));
process.env.AGENT_RUNTIME_DIR = RUNTIME_SANDBOX;
test.after(() => rmSync(RUNTIME_SANDBOX, { recursive: true, force: true }));

function withPlansDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'copilot-plans-'));
  const prev = process.env.AGENT_PLANS_DIR;
  process.env.AGENT_PLANS_DIR = dir;
  try { return fn(dir); }
  finally {
    if (prev === undefined) delete process.env.AGENT_PLANS_DIR;
    else process.env.AGENT_PLANS_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

function planArgs(planPath, extra = {}) {
  return {
    action: 'send',
    template: 'plan_review',
    cwd: TEST_CWD,
    template_args: { plan_path: planPath, ...extra },
  };
}

function sendArgs(extra = {}) {
  return { action: 'send', task: 'x', cwd: TEST_CWD, ...extra };
}

test('action schemas reject malformed inputs and normalize valid cancel/wait/status/reply calls', () => {
  assert.deepEqual([...VALID_ACTIONS].sort(), ['cancel', 'reply', 'send', 'status', 'wait']);
  assert.throws(() => validateAgentArgs({}), /action is required/);
  assert.throws(() => validateAgentArgs({ action: 'launch' }), /action must be one of/);

  const cancel = validateAgentArgs({ action: 'cancel', job_id: 'abc-123' });
  assert.deepEqual(cancel, { action: 'cancel', job_id: 'abc-123', host_session_id: null });
  assert.throws(() => validateAgentArgs({ action: 'cancel' }), /job_id/);
  assert.throws(() => validateAgentArgs({ action: 'cancel', job_id: 'x', model: 'm' }), /unknown field "model"/);

  const wait = validateAgentArgs({ action: 'wait', job_id: 'j', max_wait_sec: 120 });
  assert.equal(wait.max_wait_sec, 120);
  assert.throws(() => validateAgentArgs({ action: 'wait' }), /job_id/);
  assert.throws(() => validateAgentArgs({ action: 'wait', job_id: 'j', max_wait_sec: 'x' }), /max_wait_sec/);

  const status = validateAgentArgs({ action: 'status', job_id: 'j', verbose: true });
  assert.equal(status.verbose, true);
  assert.equal(status.diagnostics, false);
  assert.equal(status.job_id, 'j');
  assert.equal(validateAgentArgs({ action: 'status', diagnostics: true }).diagnostics, true);
  assert.throws(() => validateAgentArgs({ action: 'status', verbose: 'yes' }), /verbose must be a boolean/);
  assert.throws(() => validateAgentArgs({ action: 'status', diagnostics: 'yes' }), /diagnostics must be a boolean/);

  const reply = validateAgentArgs({ action: 'reply', job_id: 'job-1', message: 'add tests' });
  assert.equal(reply.message, 'add tests');
  assert.throws(() => validateAgentArgs({ action: 'reply', message: 'hi' }), /job_id/);
  assert.throws(() => validateAgentArgs({ action: 'reply', job_id: 'job-1' }), /message/);
  assert.throws(() => validateAgentArgs({ action: 'reply', job_id: 'job-1', message: '' }), /message/);
  assert.throws(() => validateAgentArgs({ action: 'reply', job_id: 'job-1', message: 'x'.repeat(8001) }), /too long/);
  assert.throws(() => validateAgentArgs({ action: 'reply', job_id: 'j', message: 'm', thread: 'x' }), /unknown field/);
});

test('send validation covers defaults, modes, unknown fields, thread names, cwd, and base template_args shape', () => {
  assert.deepEqual([...VALID_TEMPLATES].sort(), ['general', 'plan_review', 'research', 'review']);

  const basic = validateAgentArgs(sendArgs());
  assert.equal(basic.mode, DEFAULT_MODE);
  assert.equal(basic.template, 'general');
  assert.equal(basic.parallel, 'auto');

  for (const mode of VALID_MODES) {
    assert.equal(validateAgentArgs(sendArgs({ mode })).mode, mode);
  }

  assert.throws(() => validateAgentArgs({ action: 'send' }), /task is required/);
  assert.throws(() => validateAgentArgs(sendArgs({ model: 'gpt-5.4' })), /unknown field "model"/);
  assert.throws(() => validateAgentArgs(sendArgs({ rubber_duck: false })), /unknown field "rubber_duck"/);
  assert.throws(() => validateAgentArgs(sendArgs({ mode: 'write' })), /mode must be one of/);
  assert.throws(() => validateAgentArgs(sendArgs({ template: 'fleet' })), /template must be one of/);

  assert.equal(validateAgentArgs(sendArgs({ thread: 'my_branch.01-a' })).thread, 'my_branch.01-a');
  assert.throws(() => validateAgentArgs(sendArgs({ thread: '../etc' })), /thread must match/);
  assert.throws(() => validateAgentArgs(sendArgs({ thread: 'a/b' })), /thread must match/);

  assert.throws(() => validateAgentArgs({ action: 'send', task: 'x' }), /cwd is required/);
  assert.throws(() => validateAgentArgs(sendArgs({ cwd: 'relative/path' })), /cwd must be an absolute path/);
  assert.throws(() => validateAgentArgs(sendArgs({ cwd: '/__nope__/__nope__' })), /cwd does not exist/);
  assert.throws(() => validateAgentArgs(sendArgs({ template_args: [] })), /template_args must be a plain object/);
});

test('send validation handles strength/profile open-string siblings with mutual exclusion', () => {
  // Defaults to null when absent.
  const basic = validateAgentArgs(sendArgs());
  assert.equal(basic.profile, null);
  assert.equal(basic.strength, null);

  // strength accepted (case/space normalized) against the closed vocabulary.
  assert.equal(validateAgentArgs(sendArgs({ strength: 'Reviewer' })).strength, 'reviewer');
  for (const s of ['reviewer', 'web_researcher', 'planner', 'fast_executor']) {
    assert.equal(validateAgentArgs(sendArgs({ strength: s })).strength, s);
  }
  assert.throws(() => validateAgentArgs(sendArgs({ strength: 'archivist' })), /strength must be one of/);
  assert.throws(() => validateAgentArgs(sendArgs({ strength: 42 })), /strength must be a string/);

  // profile shape-checked only (existence deferred to the server registry).
  assert.equal(validateAgentArgs(sendArgs({ profile: 'cop-review' })).profile, 'cop-review');
  assert.throws(() => validateAgentArgs(sendArgs({ profile: 'Cop-Review' })), /profile must match/);
  assert.throws(() => validateAgentArgs(sendArgs({ profile: 'a/b' })), /profile must match/);

  // Mutual exclusion of {profile, strength}; an explicit target may co-exist.
  assert.throws(() => validateAgentArgs(sendArgs({ profile: 'cop-review', strength: 'reviewer' })), /pass only one of profile or strength/);
  const refine = validateAgentArgs(sendArgs({ strength: 'reviewer', target: 'copilot' }));
  assert.equal(refine.strength, 'reviewer');
  assert.equal(refine.target, 'copilot');

  // MCP boundary still rejects unknown keys.
  assert.throws(() => validateAgentArgs(sendArgs({ strengths: 'reviewer' })), /unknown field "strengths"/);
});

test('target:"codex" and target:"antigravity" are accepted alongside opencode and copilot', () => {
  assert.deepEqual([...VALID_TARGETS].sort(), ['antigravity', 'codex', 'copilot', 'opencode']);
  assert.equal(validateAgentArgs(sendArgs({ target: 'codex' })).target, 'codex');
  assert.equal(validateAgentArgs(sendArgs({ target: 'antigravity' })).target, 'antigravity');
  assert.throws(() => validateAgentArgs(sendArgs({ target: 'goose' })), /target must be one of/);
});

test('plan_review validates plan path existence, canonicalization, latest resolution, focus, and accepts plans outside the plans dir', () => {
  assert.throws(() => validateAgentArgs({ action: 'send', template: 'plan_review' }),
    /requires template_args\.plan_path/);
  assert.throws(() => validateAgentArgs(planArgs('rel.md')), /plan_path must be absolute/);
  assert.throws(() => validateAgentArgs(planArgs('/tmp/<foo>.md')), /un-substituted placeholder/);

  withPlansDir((dir) => {
    const oldPlan = join(dir, 'old.md');
    const newPlan = join(dir, 'new.md');
    writeFileSync(oldPlan, '# old');
    writeFileSync(newPlan, '# new');
    utimesSync(oldPlan, new Date(1000), new Date(1000));
    utimesSync(newPlan, new Date(2000), new Date(2000));

    const accepted = validateAgentArgs(planArgs(oldPlan, { focus_directive: 'security' }));
    assert.equal(accepted.template, 'plan_review');
    assert.equal(accepted.task, null);
    assert.equal(accepted.template_args.focus_directive, 'security');
    assert.ok(accepted.template_args.plan_path.endsWith('old.md'));

    const latest = validateAgentArgs(planArgs('latest'));
    assert.ok(latest.template_args.plan_path.endsWith('new.md'));

    assert.throws(() => validateAgentArgs(planArgs(oldPlan, { bogus_key: 'x' })),
      /unknown template_args key "bogus_key"/);
    assert.throws(() => validateAgentArgs(planArgs(oldPlan, { focus_directive: 42 })),
      /focus_directive must be a string/);
  });

  // The plans dir is a lookup scope for "latest", not a containment: a plan
  // may live anywhere the companion can read (a session scratchpad, a repo
  // docs/ folder, the other host's plans dir). Every shipped companion reads
  // the whole filesystem on its own, so confining the *named* path bought
  // nothing and cost a bounced dispatch plus a stale duplicate of the plan.
  const insideDir = mkdtempSync(join(tmpdir(), 'copilot-plans-'));
  const outsideDir = mkdtempSync(join(tmpdir(), 'copilot-out-'));
  const prev = process.env.AGENT_PLANS_DIR;
  process.env.AGENT_PLANS_DIR = insideDir;
  try {
    const outsidePlan = join(outsideDir, 'scratch-plan.md');
    writeFileSync(outsidePlan, '# scratch');
    const outsideReal = realpathSync(outsidePlan);
    // Plain file outside the plans dir: accepted, canonicalised.
    const direct = validateAgentArgs(planArgs(outsidePlan));
    assert.equal(direct.template_args.plan_path, outsideReal);
    // Symlink inside the plans dir pointing outside: accepted, and the prompt
    // gets the dereferenced target, never the link.
    const link = join(insideDir, 'innocent.md');
    symlinkSync(outsidePlan, link);
    const viaLink = validateAgentArgs(planArgs(link));
    assert.equal(viaLink.template_args.plan_path, outsideReal);
    // Dangling symlink still fails at existence, before canonicalisation.
    const dangling = join(insideDir, 'dangling.md');
    symlinkSync(join(outsideDir, 'missing.md'), dangling);
    assert.throws(() => validateAgentArgs(planArgs(dangling)), /does not exist/);
    // A directory is still not a plan.
    assert.throws(() => validateAgentArgs(planArgs(outsideDir)), /is not a file/);
    // "latest" is still scoped to the plans dir: the only .md there is the
    // symlink, so it resolves to that link's target rather than anything in
    // outsideDir by its own name.
    const latest = validateAgentArgs(planArgs('latest'));
    assert.equal(latest.template_args.plan_path, outsideReal);
    // Only "nothing there" is skippable. A candidate that exists but cannot be
    // stat'ed (its directory is unreadable) must surface, not silently lose to
    // an older plan — that would be the fallback this bridge refuses.
    // Root can stat anything, so the case is meaningless there.
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      const lockedDir = join(outsideDir, 'locked');
      mkdirSync(lockedDir);
      writeFileSync(join(lockedDir, 'plan.md'), '# locked');
      symlinkSync(join(lockedDir, 'plan.md'), join(insideDir, 'locked.md'));
      chmodSync(lockedDir, 0o000);
      try {
        assert.throws(() => validateAgentArgs(planArgs('latest')), /could not stat candidate .*locked\.md: EACCES/);
      } finally {
        chmodSync(lockedDir, 0o700);
      }
    }
  } finally {
    if (prev === undefined) delete process.env.AGENT_PLANS_DIR;
    else process.env.AGENT_PLANS_DIR = prev;
    rmSync(insideDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('formatPrompt and appendRubberDuckReview render template-specific instructions', () => {
  const general = formatPrompt({ template: 'general', task: 'do thing', mode: 'EXECUTE', parallel: 'never' });
  assert.match(general, /^TASK: do thing\n/);
  assert.match(general, /Mode: EXECUTE/);

  const plan = formatPrompt({ template: 'general', task: 't', mode: 'PLAN', parallel: 'never' });
  assert.match(plan, /Do not modify any files/);
  assert.match(plan, /numbered implementation plan/);

  const analyze = formatPrompt({
    template: 'general', task: 'X', mode: 'ANALYZE',
    template_args: { scope_hint: 'imports/types only' },
    parallel: 'never',
  });
  assert.match(analyze, />200 LOC/);
  assert.match(analyze, /\nScope: imports\/types only\n/);

  const research = formatPrompt({ template: 'research', task: 'what is X', parallel: 'never' });
  assert.match(research, /research assistant/);
  assert.doesNotMatch(research, /`edit`/);

  const wrapped = appendRubberDuckReview('BASE');
  assert.match(wrapped, /^BASE\n/);
  assert.match(wrapped, /CROSS-EXAMINATION STEP/);
  assert.match(wrapped, /RUBBER-DUCK: clean\./);
  assert.match(wrapped, /RUBBER-DUCK: revised/);
});

test('parallel strategy controls /fleet prefixes consistently across templates', () => {
  assert.equal(validateAgentArgs(sendArgs({ task: 'X', template: 'general' })).parallel, 'auto');
  assert.equal(validateAgentArgs(sendArgs({ task: 'X', template: 'general', parallel: 'never' })).parallel, 'never');
  assert.equal(validateAgentArgs(sendArgs({ task: 'X', template: 'research' })).parallel, 'auto');
  assert.equal(validateAgentArgs(sendArgs({ task: 'X', template: 'research', parallel: 'always' })).parallel, 'always');
  assert.throws(() => validateAgentArgs(sendArgs({ task: 'X', template: 'general', parallel: 'yes' })), /parallel must be one of auto\|always\|never/);
  assert.throws(() => validateAgentArgs(sendArgs({ task: 'X', template: 'general', parallel: false })), /parallel must be one of auto\|always\|never/);

  assert.match(formatPrompt({ template: 'general', task: 'do thing', mode: 'EXECUTE', parallel: 'always' }), /^\/fleet do thing\n/);
  assert.match(formatPrompt({ template: 'general', task: 'do thing', mode: 'EXECUTE', parallel: 'never' }), /^TASK: do thing\n/);
  assert.match(formatPrompt({ template: 'research', task: 'find X across several sources', parallel: 'auto' }), /^\/fleet You are a research assistant/);
  assert.match(formatPrompt({ template: 'research', task: 'find X', parallel: 'never' }), /^You are a research assistant/);

  withPlansDir((dir) => {
    const planFile = join(dir, 'p.md');
    writeFileSync(planFile, '# plan');
    const on = validateAgentArgs(planArgs(planFile, {}));
    const off = validateAgentArgs({ ...planArgs(planFile, {}), parallel: 'never' });
    assert.equal(on.parallel, 'auto');
    assert.equal(off.parallel, 'never');
    assert.match(formatPrompt({ template: 'plan_review', template_args: on.template_args, parallel: 'auto' }),
      /^\/fleet You are a senior software architect/);
    assert.match(formatPrompt({ template: 'plan_review', template_args: off.template_args, parallel: 'never' }),
      /^You are a senior software architect/);
  });
});

test('scope_hint is accepted only for general prompts and bounded by type and length', () => {
  const accepted = validateAgentArgs({
    action: 'send', task: 'X', cwd: TEST_CWD, template: 'general',
    template_args: { scope_hint: 'imports only' },
  });
  assert.equal(accepted.template_args.scope_hint, 'imports only');
  assert.match(formatPrompt({
    template: 'general', task: 'X', mode: 'ANALYZE',
    template_args: accepted.template_args,
    parallel: 'never',
  }), /\nScope: imports only\n/);
  assert.doesNotMatch(formatPrompt({ template: 'general', task: 'X', mode: 'ANALYZE', parallel: 'never' }), /\nScope:/);

  assert.throws(() => validateAgentArgs({
    action: 'send', task: 'X', cwd: TEST_CWD, template: 'research',
    template_args: { scope_hint: 'X' },
  }), /unknown template_args key "scope_hint" for template="research"/);
  assert.throws(() => validateAgentArgs({
    action: 'send', task: 'X', cwd: TEST_CWD, template: 'general',
    template_args: { plan_path: '/tmp/x.md' },
  }), /unknown template_args key "plan_path" for template="general"/);
  assert.throws(() => validateAgentArgs({
    action: 'send', task: 'X', cwd: TEST_CWD, template: 'general',
    template_args: { scope_hint: 42 },
  }), /scope_hint must be a string/);
  assert.throws(() => validateAgentArgs({
    action: 'send', task: 'X', cwd: TEST_CWD, template: 'general',
    template_args: { scope_hint: 'x'.repeat(501) },
  }), /scope_hint too long/);

  withPlansDir((dir) => {
    const planFile = join(dir, 'p.md');
    writeFileSync(planFile, '# plan');
    assert.throws(() => validateAgentArgs(planArgs(planFile, { scope_hint: 'nope' })),
      /unknown template_args key "scope_hint" for template="plan_review"/);
  });
});

test('host_session_id normalizes across actions and rejects invalid values', () => {
  const actions = [
    { action: 'send', task: 'X', cwd: TEST_CWD, host_session_id: 'sid-abc' },
    { action: 'wait', job_id: 'j1', host_session_id: 'sid-abc' },
    { action: 'status', host_session_id: 'sid-abc' },
    { action: 'reply', job_id: 'j1', message: 'hi', host_session_id: 'sid-abc' },
    { action: 'cancel', job_id: 'j1', host_session_id: 'sid-abc' },
  ];
  for (const action of actions) {
    assert.equal(validateAgentArgs(action).host_session_id, 'sid-abc', `${action.action} normalized host_session_id`);
  }

  assert.throws(() => validateAgentArgs({ action: 'status', host_session_id: 42 }),
    /host_session_id must be a non-empty string/);
  assert.throws(() => validateAgentArgs({ action: 'status', host_session_id: '' }),
    /host_session_id must be a non-empty string/);
  assert.equal(validateAgentArgs({ action: 'status' }).host_session_id, null);
  // claude_session_id was collapsed into host_session_id — it is now an unknown key.
  assert.throws(() => validateAgentArgs({ action: 'status', claude_session_id: 'x' }),
    /unknown field "claude_session_id"/);
});

test('review template: read-only reviewer prompt with a required verdict line, task-driven, no template_args, no wrapper, no auto-fleet', () => {
  assert.ok(VALID_TEMPLATES.has('review'));
  const accepted = validateAgentArgs(sendArgs({ task: 'Check that sum() adds', template: 'review' }));
  assert.equal(accepted.template, 'review');
  assert.equal(accepted.task, 'Check that sum() adds');
  // Task-driven like general/research: the subject under review IS the task.
  assert.throws(() => validateAgentArgs({ action: 'send', template: 'review', cwd: TEST_CWD }), /task/);
  assert.throws(() => validateAgentArgs(sendArgs({ task: 'X', template: 'review', template_args: { scope_hint: 'x' } })),
    /unknown template_args key "scope_hint" for template="review"/);
  assert.throws(() => validateAgentArgs(sendArgs({ task: 'X', template: 'review', template_args: { plan_path: '/tmp/x.md' } })),
    /unknown template_args key "plan_path" for template="review"/);

  const prompt = formatPrompt({ template: 'review', task: 'Check that sum() adds', mode: 'EXECUTE', parallel: 'never' });
  assert.match(prompt, /Check that sum\(\) adds/);
  // Read-only by construction, whatever mode the caller passed.
  assert.match(prompt, /DO NOT modify any files/);
  // The contract the parser below reads — both spellings, as the LAST line.
  assert.match(prompt, /VERDICT: agree/);
  assert.match(prompt, /VERDICT: disagree/);
  assert.match(prompt, /LAST line/);
  // The follow-up hook: round two refers back to round one by finding number.
  assert.match(prompt, /earlier findings by number/);
  // Its critique is its own — the rubber-duck wrapper is not layered on top.
  assert.doesNotMatch(prompt, /RUBBER-DUCK/);
  assert.ok(RUBBER_DUCK_EXEMPT_TEMPLATES.has('review'));
  assert.ok(RUBBER_DUCK_EXEMPT_TEMPLATES.has('plan_review'));
  assert.ok(!RUBBER_DUCK_EXEMPT_TEMPLATES.has('general'));
  // One reviewer, one verdict line: `auto` never fans a review out, even when
  // the task reads broad; an explicit `always` still can.
  assert.equal(shouldUseFleet({ parallel: 'auto', template: 'review', task: 'review and audit the auth, billing and API routes across multiple files' }), false);
  assert.doesNotMatch(formatPrompt({ template: 'review', task: 'review everything across multiple files', mode: 'ANALYZE', parallel: 'auto' }), /^\/fleet/);
  assert.match(formatPrompt({ template: 'review', task: 'X', mode: 'ANALYZE', parallel: 'always' }), /^\/fleet /);
});

test('the review verdict parser never guesses: missing, malformed and conflicting lines are null with a reason', () => {
  const cases = [
    ['1. sum.mjs returns a - b.\n\nVERDICT: disagree — sum() subtracts', { verdict: 'disagree', reason: null }],
    ['No findings.\n\nVERDICT: agree — the claim holds', { verdict: 'agree', reason: null }],
    ['**VERDICT:** agree', { verdict: 'agree', reason: null }],
    ['VERDICT: "agree"', { verdict: 'agree', reason: null }],
    ['- VERDICT: disagree', { verdict: 'disagree', reason: null }],
    ['body\n verdict: Agree.', { verdict: 'agree', reason: null }],
    // The same value twice (a fleet of reviewers agreeing) is that value.
    ['VERDICT: agree\nmore\nVERDICT: agree — still', { verdict: 'agree', reason: null }],
    // Nothing to read.
    ['looks fine to me', { verdict: null, reason: 'missing' }],
    ['', { verdict: null, reason: 'missing' }],
    [null, { verdict: null, reason: 'missing' }],
    [undefined, { verdict: null, reason: 'missing' }],
    // A value the contract does not define — plan_review's vocabulary included.
    ['VERDICT: approve', { verdict: null, reason: 'malformed' }],
    ['VERDICT: agreed', { verdict: null, reason: 'malformed' }],
    ['VERDICT: maybe\nVERDICT: agree', { verdict: null, reason: 'malformed' }],
    // Two lines that disagree with each other.
    ['VERDICT: agree\n…\nVERDICT: disagree — actually no', { verdict: null, reason: 'conflicting' }],
    // Prose mentioning the word is not a verdict line.
    ['My verdict: it is fine.', { verdict: null, reason: 'missing' }],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(classifyReviewVerdict(input), expected, `input=${JSON.stringify(input)}`);
  }
});
