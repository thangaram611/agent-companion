// Host detection + per-host path resolution tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  detectHost,
  _resetHostCacheForTests,
  companionHomeDir,
  HOSTS,
  settingsFile,
} from '../lib/hosts/index.mjs';

const agentsDir = host => join(HOSTS[host].configDir(), 'agents');

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
  withEnv('CODEX_HOME', undefined, () => {
    assert.deepEqual({
      claudeHome: companionHomeDir('claude'),
      codexHome: companionHomeDir('codex'),
      claudeAgents: agentsDir('claude'),
      codexAgents: agentsDir('codex'),
      claudeSettings: settingsFile('claude'),
      codexSettings: settingsFile('codex'),
    }, {
      claudeHome: join(homedir(), '.claude', 'agent-companion'),
      codexHome: join(homedir(), '.codex', 'agent-companion'),
      claudeAgents: join(homedir(), '.claude', 'agents'),
      codexAgents: join(homedir(), '.codex', 'agents'),
      claudeSettings: join(homedir(), '.claude', 'settings.json'),
      codexSettings: join(homedir(), '.codex', 'config.toml'),
    });
  });
});

test('CODEX_HOME relocates every Codex path without affecting Claude paths', () => {
  const custom = join(homedir(), 'custom codex home');
  withEnv('CODEX_HOME', custom, () => {
    assert.equal(companionHomeDir('codex'), join(custom, 'agent-companion'));
    assert.equal(agentsDir('codex'), join(custom, 'agents'));
    assert.equal(settingsFile('codex'), join(custom, 'config.toml'));
    assert.equal(companionHomeDir('claude'), join(homedir(), '.claude', 'agent-companion'));
  });
});

const paths = {
  claude: { config: '/fake home/.claude', data: '/plugin root/.plugin-data', settings: 'settings.json', wall: 'timeout', scale: 1000 },
  codex: { config: '/custom codex', data: '/custom codex/plugins/data/agent-companion-agent-companion', settings: 'config.toml', wall: 'tool_timeout_sec', scale: 1 },
};

for (const host of Object.values(HOSTS)) test(`${host.id} paths, shell hooks and bridge registration`, () => {
  const root = '/plugin root';
  const { config, data, settings, wall, scale } = paths[host.id];
  const script = '. ./hooks/host-paths.sh && host_paths "$1" "$2" && printf "%s\\n" "$HOST_CONFIG_DIR" "$HOST_STATE_DIR" "$HOST_PLUGIN_DATA"';
  for (const overrides of [{ CODEX_HOME: '/custom codex' }, {}, { CODEX_HOME: ' ./old/../custom codex/ ' }, { PLUGIN_DATA: '/plugin data', CLAUDE_PLUGIN_DATA: '/claude data' }]) {
    const env = { HOME: '/fake home', ...overrides };
    const dirs = [host.configDir(env), host.stateDir(env), host.pluginDataDir(env, root)];
    if (env.CODEX_HOME === '/custom codex') {
      assert.deepEqual(dirs, [config, join(config, 'agent-companion'), data]);
      assert.equal(host.settingsFile(env), join(config, settings));
    }
    const shell = execFileSync('/bin/bash', ['-c', script, 'bash', host.id, root], { cwd: new URL('..', import.meta.url), env, encoding: 'utf8' });
    assert.deepEqual(shell.trimEnd().split('\n'), dirs);
  }
  const manifest = JSON.parse(readFileSync(new URL(`../.${host.id}-plugin/plugin.json`, import.meta.url)));
  const bridge = manifest.mcpServers['agent-bridge'];
  assert.equal(bridge.env.AGENT_COMPANION_HOST, host.id);
  assert.equal(bridge[wall], 1320 * scale);
  assert.ok(bridge[wall] / scale > 1200);
});
