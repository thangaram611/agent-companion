import '../test/sandbox-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRouting, dispatch, _resetForTest } from './server.mjs';
import { clearDefaultTarget, writeDefaultTarget, writeDefaultModel, clearDefaultModel, writeTargetChecks } from '../lib/state.mjs';
import { getTarget } from '../lib/target-registry.mjs';

test('target routing is explicit or configured, with no silent substitute', () => {
  clearDefaultTarget();
  assert.equal(resolveRouting({}, {}).code, 'TARGET_UNCONFIGURED');
  writeDefaultTarget('copilot');
  assert.equal(resolveRouting({}, {}).resolved.companion, 'copilot');
  assert.equal(resolveRouting({}, { AGENT_COMPANION_DEFAULT_TARGET: 'codex' }).resolved.companion, 'codex');
  assert.equal(resolveRouting({ target: 'opencode' }, {}).resolved.companion, 'opencode');
  assert.equal(resolveRouting({ target: 'unsupported' }, {}).code, 'TARGET_UNSUPPORTED');
  clearDefaultTarget();
});

test('per-companion model defaults inherit when unset and explicit overrides win', () => {
  for (const target of ['copilot', 'codex', 'opencode', 'antigravity', 'claude']) {
    clearDefaultModel(target);
    assert.equal(resolveRouting({ target }, {}).resolved.model, null);
    const configured = target === 'opencode' ? 'provider/default' : 'gpt-5.4';
    writeDefaultModel(configured, target);
    assert.equal(resolveRouting({ target }, {}).resolved.model, configured);
    const model = target === 'opencode' ? 'provider/override' : 'gpt-5.3-codex';
    assert.equal(resolveRouting({ target, model }, {}).resolved.model, model);
    clearDefaultModel(target);
  }
  assert.equal(resolveRouting({ target: 'codex' }, { AGENT_COMPANION_CODEX_MODEL: 'gpt-5.4' }).resolved.model, 'gpt-5.4');
});

test('a model override is refused when the selected companion cannot select models', () => {
  const caps = getTarget('copilot').capabilities;
  const previous = caps.modelSelection;
  caps.modelSelection = false;
  try {
    assert.equal(resolveRouting({ target: 'copilot', model: 'gpt-5.4' }, {}).code, 'CAPABILITY_UNAVAILABLE');
    assert.equal(resolveRouting({ target: 'copilot' }, {}).ok, true);
  } finally {
    caps.modelSelection = previous;
  }
});

test('routing refusals retain the envelope without profiles or strengths', async () => {
  _resetForTest();
  writeTargetChecks({ copilot: { ready: true } });
  const prior = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'routing-test';
  try {
    const result = (await dispatch({ action: 'send', target: 'copilot', model: 'unknown', task: 'x', cwd: '/tmp', thread: 'routing-child' })).structuredContent;
    assert.equal(result.ok, false);
    assert.equal(result.action, 'send');
    assert.equal(result.code, 'MODEL_NOT_ALLOWED');
    assert.equal(result.status, 'MODEL_NOT_ALLOWED');
    for (const field of ['profiles', 'strengths', 'candidates']) assert.equal(Object.hasOwn(result, field), false);
  } finally {
    if (prior === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = prior;
    _resetForTest();
  }
});

test('effort routing advertises static CLI levels and defers model-specific levels to adapters', () => {
  assert.equal(getTarget('codex').capabilities.effortSelection, true);
  assert.equal(getTarget('codex').capabilities.effortLevels, null);
  assert.equal(resolveRouting({ target: 'codex', effort: 'low' }, {}).resolved.effort, 'low');
  const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
  assert.equal(getTarget('claude').capabilities.effortSelection, true);
  assert.deepEqual(getTarget('claude').capabilities.effortLevels, levels);
  for (const effort of levels) assert.equal(resolveRouting({ target: 'claude', effort }, {}).resolved.effort, effort);
  const invalid = resolveRouting({ target: 'claude', effort: 'minimal' }, {});
  assert.equal(invalid.code, 'EFFORT_NOT_ALLOWED');
  assert.equal(invalid.effort, 'minimal');
  for (const level of levels) assert.ok(invalid.hint.includes(level));
  for (const target of ['opencode', 'copilot', 'antigravity']) {
    assert.equal(getTarget(target).capabilities.effortSelection, true);
    assert.equal(resolveRouting({ target, effort: 'low' }, {}).resolved.effort, 'low');
    assert.equal(resolveRouting({ target }, {}).resolved.effort, null);
  }
  const copilotLevels = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  assert.deepEqual(getTarget('copilot').capabilities.effortLevels, copilotLevels);
  for (const effort of copilotLevels) assert.equal(resolveRouting({ target: 'copilot', effort }, {}).resolved.effort, effort);
  assert.equal(resolveRouting({ target: 'copilot', effort: 'ultra' }, {}).code, 'EFFORT_NOT_ALLOWED');
});
