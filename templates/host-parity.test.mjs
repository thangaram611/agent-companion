// Host parity: the two templates must offer the END USER the same thing.
//
// agent-companion is a host-neutral bridge, not a Claude plugin that happens to
// run elsewhere. The matrix is {claude, codex} hosts x {opencode, copilot,
// codex} companions, and a capability that exists on one host and not the other
// is a bug in the product, not a detail of the port.
//
// The two templates configure the same bridge through different host
// mechanisms, so they cannot be compared line by line:
//
//   Claude  templates/agent-companion.md    YAML frontmatter, `env:` mapping,
//                                           per-server `timeout:` in MILLISECONDS
//   Codex   templates/agent-companion.toml  TOML, `env = {}` inline table,
//                                           `tool_timeout_sec` in SECONDS
//
// MECHANISM may diverge; CAPABILITY may not. This file asserts the second half.
// Each template's own suite (agent-companion.md.test.mjs,
// agent-companion.toml.test.mjs) owns the first.
//
// Why it exists: the app-server adapter shipped documented in the Claude
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

// Keys that name WHICH host the file is, so they cannot have a twin by
// construction. Everything else in an env block is a capability knob.
const HOST_IDENTITY_KEYS = new Set(['AGENT_COMPANION_HOST']);

// The Claude host's `env:` mapping, from the frontmatter's agent-bridge server.
// Comment lines are stripped first: a knob documented in a comment is NOT set,
// and the whole point here is what the bridge actually receives.
function claudeEnv() {
  const fm = md.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(fm, 'the Claude template must have extractable frontmatter');
  const lines = fm[1].split('\n').filter((line) => !/^\s*#/.test(line));
  const start = lines.findIndex((line) => /^\s{6}env:\s*$/.test(line));
  if (start === -1) return {};
  const env = {};
  for (const line of lines.slice(start + 1)) {
    const kv = line.match(/^\s{8}([A-Z0-9_]+):\s*(.+?)\s*$/);
    if (!kv) break; // dedent ends the block
    env[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

// The Codex host's `env = { ... }` inline table on [mcp_servers.agent-bridge].
function codexEnv() {
  const active = toml.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  const m = active.match(/^env\s*=\s*\{([^}]*)\}\s*$/m);
  if (!m) return {};
  const env = {};
  for (const pair of m[1].split(',')) {
    const kv = pair.match(/\s*([A-Z0-9_]+)\s*=\s*"([^"]*)"\s*/);
    if (kv) env[kv[1]] = kv[2];
  }
  return env;
}

const capabilityKeys = (env) => Object.keys(env).filter((k) => !HOST_IDENTITY_KEYS.has(k)).sort();

test('both hosts ship the same capability knobs, with the same values', () => {
  const claude = claudeEnv();
  const codex = codexEnv();

  assert.deepEqual(capabilityKeys(claude), capabilityKeys(codex),
    'a knob set for one host and not the other gives the two an unequal feature set — '
    + 'set it in both templates, or neither');

  for (const key of capabilityKeys(claude)) {
    assert.equal(claude[key], codex[key],
      `${key} differs between hosts (claude=${claude[key]} codex=${codex[key]}): `
      + 'the same dispatch would behave differently depending on which host launched the bridge');
  }
});

test('the codex transport is the app-server adapter on both hosts', () => {
  // Pinned by name rather than left to the generic comparison above, because
  // this is the one knob whose absence is silently destructive: on `exec` a job
  // dies with the bridge that started it, and the operator is told the truth
  // only after the work is gone.
  for (const [host, env] of [['claude', claudeEnv()], ['codex', codexEnv()]]) {
    assert.equal(env.CODEX_RUNTIME_ADAPTER, 'appserver',
      `the ${host} host must select the app-server transport`);
  }
});

test('each host still identifies itself, and only the Codex one needs to', () => {
  // lib/host.mjs defaults to 'claude', so the Claude template setting it would
  // be redundant; the Codex template MUST, or its state lands in ~/.claude/.
  assert.equal(codexEnv().AGENT_COMPANION_HOST, 'codex');
  assert.equal(claudeEnv().AGENT_COMPANION_HOST, undefined,
    'the Claude host is lib/host.mjs\'s default — setting it here would be noise that can drift');
});
