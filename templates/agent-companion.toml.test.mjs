// Schema/structural sanity tests for templates/agent-companion.toml.
//
// Current Codex deliberately rejects role-local MCP authority. This file must
// therefore contain only role fields; the Codex-only plugin manifest owns the
// operative bridge registration and its separate marketplace tests.
//
// If a future edit ever pulls @iarna/toml or a built-in TOML parser into
// scope, replace these checks with a real parse + structural assertions.

import '../test/sandbox-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOML_PATH = join(HERE, 'agent-companion.toml');
const text = readFileSync(TOML_PATH, 'utf8');

const topLevel = text;

test('role fields stay top-level and use an allowlisted model', async () => {
  assert.match(topLevel, /^name\s*=\s*"agent-companion"\s*$/m);
  assert.match(topLevel, /^description\s*=\s*"""/m);
  // Keep this as a role-level field; moving it into a table silently changes
  // its meaning in TOML.
  assert.match(topLevel, /^developer_instructions\s*=\s*"""/m);

  const match = topLevel.match(/^model\s*=\s*"([^"]+)"\s*$/m);
  assert.ok(match, 'model field present at top level');
  const state = await import('../lib/state.mjs');
  assert.equal(state.isCodexAgentModelAllowed(match[1]), true,
    `model ${match[1]} must be in CODEX_AGENT_MODELS`);

  const di = topLevel.match(/^developer_instructions\s*=\s*"""([\s\S]*?)"""/m);
  assert.ok(di, 'developer_instructions block extractable');
  const body = di[1];
  assert.match(body, /spawn_agent/);
  assert.match(body, /send_input/);
  assert.match(body, /Status \/ acknowledgement envelope/);
  assert.match(body, /`ok: true` with no `content` \+ `meta`/);
  // Same per-job-status gap as the Claude template — see its suite for why.
  assert.match(body, /\*\*per-job status\*\*/);
  assert.match(body, /`response.ok !== true`/);
  assert.match(body, /never emit `undefined`/);
  assert.match(body, /meta\.digest_uri/);
  assert.match(body, /resource_link/);
  assert.match(body, /"diagnostics": true/);
  assert.match(body, /MCP-native doctor report/);
  assert.doesNotMatch(body, /\bAgent\(\)/, 'Claude-specific Agent() call should be replaced');
  assert.doesNotMatch(body, /SendMessage\(\)/, 'Claude-specific SendMessage() should be replaced');
  assert.doesNotMatch(body, /canonical place to look up structured per-job progress/);
});

test('role does not attempt to add MCP authority', () => {
  assert.doesNotMatch(text, /^\[mcp_servers(?:\.|\])/m);
  assert.doesNotMatch(text, /\$\{CLAUDE_PLUGIN_ROOT\}/);
  assert.doesNotMatch(text, /MCP_TOOL_TIMEOUT/);
  // The Claude template tells the agent to forward CLAUDE_CODE_SESSION_ID
  // by hand. The Codex template must NOT carry that instruction, since
  // session id is read server-side from MCP _meta.
  assert.doesNotMatch(text, /CLAUDE_CODE_SESSION_ID/,
    'Codex template should not mention CLAUDE_CODE_SESSION_ID');
});

test('role uses the Codex-normalized bridge tool namespace', () => {
  assert.match(text, /mcp__agent_bridge__agent_send/);
  assert.match(text, /mcp__agent_bridge__agent_wait/);
  assert.match(text, /mcp__agent_bridge__agent_status/);
  assert.match(text, /mcp__agent_bridge__agent_reply/);
  assert.match(text, /mcp__agent_bridge__agent_cancel/);
  assert.match(text, /tools\.mcp__agent_bridge__agent_status/);
  assert.match(text, /ALL_TOOLS/);
  assert.match(text, /Absence from the top-level schema is expected/);
  assert.doesNotMatch(text, /mcp__agent-bridge__/,
    'Codex replaces the raw server-name hyphen with an underscore in model-visible tool names');
});

test('template documents strength/profile routing without hardcoding ids', () => {
  // Wire payload doc lives in `description`; the build-the-JSON block lives in
  // `developer_instructions`. Assert across the whole materialized template.
  assert.match(text, /"strength":\s+"reviewer"/);
  assert.match(text, /"profile":\s+"\.\.\."/);
  assert.match(text, /"strength":\s+"<from input, else omit>"/);
  assert.match(text, /discover the configured set via `\{action:status\}`/);
  assert.match(text, /never pass companion or model ids/);
  assert.doesNotMatch(text, /agent_route|agent_strength|agent_profile/);
});

test('template forbids re-routing a dispatch the bridge refused to route', () => {
  // Same prohibition as the Claude template, authored host-neutrally so both
  // suites can assert it. Reported as "strength advertised but not wired";
  // forensics showed the bridge answered STRENGTH_UNCONFIGURED in 23ms and the
  // subagent re-sent the task 30s later with target:"codex" — a target the
  // parent never named. It belongs in developer_instructions (the behavioral
  // contract), not in description (the wire-payload doc).
  const di = topLevel.match(/^developer_instructions\s*=\s*"""([\s\S]*?)"""/m);
  assert.ok(di, 'developer_instructions block extractable');
  const body = di[1];
  assert.match(body, /A routing error ≠ permission to pick your own route/);
  // Includes both ambiguity codes: STRENGTH_AMBIGUOUS and PROFILE_AMBIGUOUS are
  // routing-resolution failures too, and a code missing from the enumeration is
  // exactly the gap the subagent reroutes through.
  for (const code of ['STRENGTH_UNCONFIGURED', 'STRENGTH_AMBIGUOUS', 'PROFILE_UNKNOWN',
    'PROFILE_AMBIGUOUS', 'ROUTING_CONFLICT', 'CAPABILITY_UNAVAILABLE',
    'TARGET_UNCONFIGURED', 'TARGET_UNSUPPORTED', 'MODEL_NOT_ALLOWED']) {
    assert.match(body, new RegExp(`\`${code}\``),
      `${code} named in the no-re-route prohibition`);
  }
  assert.match(body,
    /Do NOT re-send the task with a `target`, `profile`, or `strength` the parent did not supply/);
  assert.match(body, /and do NOT drop the one it did supply/);
});
