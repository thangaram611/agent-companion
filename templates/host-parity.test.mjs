// Host parity: the two templates must offer the END USER the same thing.
//
// agent-companion is a host-neutral bridge, not a Claude plugin that happens to
// run elsewhere. The matrix is {claude, codex} hosts x {opencode, copilot,
// codex, antigravity} companions, and a capability that exists on one host and not the other
// is a bug in the product, not a detail of the port.
//
// The two templates configure the same bridge through different host
// mechanisms, so they cannot be compared line by line:
//
//   Claude  .claude-plugin/plugin.json      native plugin MCP declaration,
//                                           per-server `timeout:` in MILLISECONDS
//   Codex   .codex-plugin/plugin.json       native plugin MCP declaration,
//                                           `tool_timeout_sec` in SECONDS
//
// MECHANISM may diverge; CAPABILITY may not. This file asserts the second half.
// Each template's own suite (agent-companion.md.test.mjs,
// agent-companion.toml.test.mjs) owns the first.
//
// Historical origin (retired survival design): the app-server adapter shipped documented in the Claude
// template only. Nothing compared the pair, so a codex-host operator would have
// silently kept the transport whose jobs die with the bridge — the exact defect
// the adapter was built to fix, present or absent depending on which host you
// launched from.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const md = readFileSync(join(HERE, 'agent-companion.md'), 'utf8');
const toml = readFileSync(join(HERE, 'agent-companion.toml'), 'utf8');
const claudeManifest = JSON.parse(readFileSync(join(HERE, '..', '.claude-plugin', 'plugin.json'), 'utf8'));
const codexManifest = JSON.parse(readFileSync(
  join(HERE, '..', '.codex-plugin', 'plugin.json'),
  'utf8',
));

// Keys that name WHICH host the file is, so they cannot have a twin by
// construction. Everything else in an env block is a capability knob.
const HOST_IDENTITY_KEYS = new Set(['AGENT_COMPANION_HOST']);

// Both hosts now configure the session-scoped server in their plugin manifest.
function claudeEnv() {
  return claudeManifest.mcpServers?.['agent-bridge']?.env || {};
}

// Current Codex roles cannot add MCP authority. The operative Codex env is
// therefore the plugin-scoped native MCP declaration that the role inherits.
function codexEnv() {
  return codexManifest.mcpServers?.['agent-bridge']?.env || {};
}

const capabilityKeys = (env) => Object.keys(env).filter((k) => !HOST_IDENTITY_KEYS.has(k)).sort();

test('both hosts ship the same capability knobs, with the same values', () => {
  const claude = claudeEnv();
  const codex = codexEnv();

  assert.deepEqual(capabilityKeys(claude), ['AGENT_COMPANION_OWNER_GRACE_MS'],
    'Both hosts configure the owner attachment grace');
  assert.deepEqual(capabilityKeys(claude), capabilityKeys(codex),
    'a knob set for one host and not the other gives the two an unequal feature set — '
    + 'set it in both templates, or neither');

  for (const key of capabilityKeys(claude)) {
    assert.equal(claude[key], codex[key],
      `${key} differs between hosts (claude=${claude[key]} codex=${codex[key]}): `
      + 'the same dispatch would behave differently depending on which host launched the bridge');
  }
});

test('both hosts set the same effective tool deadline above the wait cap', () => {
  const timeout = claudeManifest.mcpServers['agent-bridge'].timeout;
  assert.equal(timeout, codexManifest.mcpServers['agent-bridge'].tool_timeout_sec * 1000);
  assert.ok(timeout > 1200 * 1000);
});

test('both hosts offer the same six private tools and conversational send fields', () => {
  const claude = md.slice(md.indexOf('\n---\n') + 5);
  const codex = toml.match(/^developer_instructions\s*=\s*"""([\s\S]*?)"""/m)[1];
  for (const body of [claude, codex]) {
    const names = [...new Set([...body.matchAll(/mcp__agent[-_]bridge__agent_([a-z]+)/g)].map((m) => m[1]))].sort();
    assert.deepEqual(names, ['cancel', 'catalog', 'reply', 'send', 'status', 'wait']);
    assert.match(body.replace(/\s+/g, ' '), /`task` and `cwd`, plus optional `target`, `model` and `max_wait_sec`/);
    assert.doesNotMatch(body, /\b(?:templates?|modes?|strengths?|profiles?|verdicts?|fleet|parallel)\b/i);
  }
  assert.deepEqual([...claude.matchAll(/^# (.+)$/gm)].map((m) => m[1]),
    [...codex.matchAll(/^# (.+)$/gm)].map((m) => m[1]));
});

test('each plugin identifies its host for the shared launcher', () => {
  assert.equal(codexEnv().AGENT_COMPANION_HOST, 'codex');
  assert.equal(claudeEnv().AGENT_COMPANION_HOST, 'claude');
});
