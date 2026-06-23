// Schema/structural sanity tests for templates/agent-companion.toml.
//
// We don't pull in a TOML parser dep just for this — but a TOML key=value
// pair declared after a `[table.section]` header is parsed as part of
// that table, not as a top-level key. That single foot-gun caused the
// developer_instructions key to silently disappear into the
// `[mcp_servers.agent-bridge]` table during initial drafting. These
// regex checks lock the structural invariants that matter:
//   - the three required fields are at the top level (declared before
//     any `[...]` table header)
//   - the bridge MCP table declares the right command/args/env
//   - the AGENT_COMPANION_HOST literal is "codex" (the route signal
//     that lib/host.mjs reads on startup)
//
// If a future edit ever pulls @iarna/toml or a built-in TOML parser into
// scope, replace these checks with a real parse + structural assertions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOML_PATH = join(HERE, 'agent-companion.toml');
const text = readFileSync(TOML_PATH, 'utf8');

// Slice out everything that comes BEFORE the first [table] header — that
// is where TOML expects top-level keys.
const firstTableIdx = text.search(/^\[[a-zA-Z_]/m);
assert.notEqual(firstTableIdx, -1, 'TOML must declare at least one table');
const topLevel = text.slice(0, firstTableIdx);

function tableBody(headerPattern) {
  const match = text.match(new RegExp(`^\\[${headerPattern}\\]\\s*$`, 'm'));
  assert.ok(match, `table [${headerPattern}] present`);
  const rest = text.slice(match.index + match[0].length);
  const nextTable = rest.search(/^\[[^\]]+\]\s*$/m);
  return match[0] + (nextTable === -1 ? rest : rest.slice(0, nextTable));
}

test('top-level TOML fields stay before the first table and use an allowlisted model', async () => {
  assert.match(topLevel, /^name\s*=\s*"agent-companion"\s*$/m);
  assert.match(topLevel, /^description\s*=\s*"""/m);
  // This is the one most likely to drift below a [table] section by
  // accident. Keeping it strictly above the first table header guards
  // against silent misparse.
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
  assert.match(body, /Status envelope/);
  assert.match(body, /never emit `undefined`/);
  assert.match(body, /meta\.digest_uri/);
  assert.match(body, /resource_link/);
  assert.match(body, /"diagnostics": true/);
  assert.match(body, /MCP-native doctor report/);
  assert.doesNotMatch(body, /\bAgent\(\)/, 'Claude-specific Agent() call should be replaced');
  assert.doesNotMatch(body, /SendMessage\(\)/, 'Claude-specific SendMessage() should be replaced');
  assert.doesNotMatch(body, /canonical place to look up structured per-job progress/);
});

test('mcp_servers.agent-bridge declares the Codex-specific command, args, env, and timeout', () => {
  assert.match(text, /^\[mcp_servers\.agent-bridge\]\s*$/m);
  const bridgeTable = tableBody('mcp_servers\\.agent-bridge');
  assert.match(bridgeTable, /^command\s*=\s*"node"\s*$/m);
  assert.match(bridgeTable,
    /^args\s*=\s*\[\s*"\$\{CLAUDE_PLUGIN_ROOT\}\/bridge-server\/server\.mjs"\s*\]\s*$/m,
    'args[0] must reference ${CLAUDE_PLUGIN_ROOT}/bridge-server/server.mjs — the install hook substitutes this at materialization time');
  // The literal env value is what lib/host.mjs reads on startup to route
  // paths under ~/.codex/. If this drifts to "claude" or gets dropped,
  // the Codex install will write into the Claude state directory.
  assert.match(bridgeTable, /AGENT_COMPANION_HOST\s*=\s*"codex"/);
  assert.doesNotMatch(bridgeTable, /MCP_TOOL_TIMEOUT/);
  assert.match(bridgeTable, /^tool_timeout_sec\s*=\s*1320\s*$/m);
  // The Claude template tells the agent to forward CLAUDE_CODE_SESSION_ID
  // by hand. The Codex template must NOT carry that instruction, since
  // session id is read server-side from MCP _meta.
  assert.doesNotMatch(text, /CLAUDE_CODE_SESSION_ID/,
    'Codex template should not mention CLAUDE_CODE_SESSION_ID');
});
