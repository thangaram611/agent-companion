// Host detection + per-host path resolution tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  detectHost,
  _resetHostCacheForTests,
  companionHomeDir,
  plansDir,
  agentsDir,
  settingsFile,
  sessionIdEnvVar,
  sanitizeHostSessionId,
} from './host.mjs';

function withEnv(key, value, fn) {
  const prior = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  _resetHostCacheForTests();
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
    _resetHostCacheForTests();
  }
}

test('detectHost handles defaults, valid/invalid env values, trimming, and memoization', () => {
  const cases = [
    [undefined, 'claude'],
    ['codex', 'codex'],
    ['claude', 'claude'],
    ['gemini', 'claude'],
    ['  codex  ', 'codex'],
  ];
  for (const [value, expected] of cases) {
    withEnv('AGENT_COMPANION_HOST', value, () => {
      assert.equal(detectHost(), expected, `env=${value}`);
    });
  }

  withEnv('AGENT_COMPANION_HOST', 'codex', () => {
    assert.equal(detectHost(), 'codex');
    process.env.AGENT_COMPANION_HOST = 'claude';
    // No cache reset → still codex.
    assert.equal(detectHost(), 'codex');
  });
});

test('per-host paths and env var names stay routed to the correct host home', () => {
  assert.deepEqual({
    claudeHome: companionHomeDir('claude'),
    codexHome: companionHomeDir('codex'),
    claudePlans: plansDir('claude'),
    codexPlans: plansDir('codex'),
    claudeAgents: agentsDir('claude'),
    codexAgents: agentsDir('codex'),
    claudeSettings: settingsFile('claude'),
    codexSettings: settingsFile('codex'),
    claudeSession: sessionIdEnvVar('claude'),
    codexSession: sessionIdEnvVar('codex'),
  }, {
    claudeHome: join(homedir(), '.claude', 'agent-companion'),
    codexHome: join(homedir(), '.codex', 'agent-companion'),
    claudePlans: join(homedir(), '.claude', 'plans'),
    codexPlans: join(homedir(), '.codex', 'plans'),
    claudeAgents: join(homedir(), '.claude', 'agents'),
    codexAgents: join(homedir(), '.codex', 'agents'),
    claudeSettings: join(homedir(), '.claude', 'settings.json'),
    codexSettings: join(homedir(), '.codex', 'config.toml'),
    claudeSession: 'CLAUDE_CODE_SESSION_ID',
    codexSession: 'CODEX_SESSION_ID',
  });
});

test('sanitizeHostSessionId preserves safe ids, compacts unsafe runs, and rejects non-strings', () => {
  const cases = [
    ['019e0dc8-94b3-7172-abeb-60578f8a8a8d', '019e0dc8-94b3-7172-abeb-60578f8a8a8d'],
    ['abc.def_ghi-jkl', 'abc.def_ghi-jkl'],
    ['a/b\\c d:e', 'a_b_c_d_e'],
    ['a//b', 'a_b'],
    ['', ''],
    [null, ''],
    [undefined, ''],
    [42, ''],
  ];
  for (const [input, expected] of cases) {
    assert.equal(sanitizeHostSessionId(input), expected, `input=${String(input)}`);
  }
});
