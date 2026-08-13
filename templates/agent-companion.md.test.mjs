import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const text = readFileSync(join(HERE, 'agent-companion.md'), 'utf8');

test('Claude template documents status response rendering explicitly', () => {
  assert.match(text, /Status envelope/);
  assert.match(text, /response has `action: "status"` and `ok: true`/);
  assert.match(text, /never emit `undefined`/);
  assert.match(text, /echo "\$CLAUDE_CODE_SESSION_ID"/);
  assert.match(text, /meta\.digest_uri/);
  assert.match(text, /resource_link/);
  assert.match(text, /"diagnostics": true/);
  assert.match(text, /MCP-native doctor report/);
  assert.doesNotMatch(text, /canonical place to look up structured per-job progress/);
});

test('Claude template documents strength/profile routing without hardcoding ids', () => {
  // The new optional routing siblings are documented beside target in both the
  // wire-payload doc and the build-the-JSON block.
  assert.match(text, /"strength":\s+"reviewer"/);
  assert.match(text, /"profile":\s+"\.\.\."/);
  assert.match(text, /"strength":\s+"<from input, else omit>"/);
  assert.match(text, /discover the configured set via `\{action:status\}`/);
  assert.match(text, /never pass companion or model ids/);
  // The tool allow-list must NOT grow — still the 5 agent_* tools plus host tools.
  assert.doesNotMatch(text, /agent_route|agent_strength|agent_profile/);
});

// Every routing-resolution code resolveRouting/resolveProfileRouting can return
// before a job ever exists (bridge-server/server.mjs). Each one means "the
// parent's routing key did not resolve" — never "try another key". The list is
// closed on purpose, so the two ambiguity codes belong in it: a strength two
// profiles declare with no defaultProfile tiebreak fails as STRENGTH_AMBIGUOUS
// (server.mjs resolveRouting), and a bare target two profiles claim fails as
// PROFILE_AMBIGUOUS (resolveBareTarget) — the same "key did not resolve" class
// that the prohibition exists to close.
const ROUTING_ERROR_CODES = [
  'STRENGTH_UNCONFIGURED', 'STRENGTH_AMBIGUOUS', 'PROFILE_UNKNOWN',
  'PROFILE_AMBIGUOUS', 'ROUTING_CONFLICT', 'CAPABILITY_UNAVAILABLE',
  'TARGET_UNCONFIGURED', 'TARGET_UNSUPPORTED', 'MODEL_NOT_ALLOWED',
];

test('Claude template sets the MCP deadline as a per-server field, not an env var', () => {
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(fm, 'frontmatter block extractable');
  const frontmatter = fm[1];

  // Measured: an `env: MCP_TOOL_TIMEOUT` does reach the bridge child process
  // and the Claude Code host ignores it outright. It is a no-op that reads like
  // a configured deadline, so it must not come back as a live key. The
  // template's own YAML comment names it on purpose (that is the warning), so
  // strip comment lines before asserting rather than banning the string.
  const active = frontmatter.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  assert.doesNotMatch(active, /MCP_TOOL_TIMEOUT/,
    'the inert MCP_TOOL_TIMEOUT env var must not return as a live frontmatter key');

  // The field the host honours is a SIBLING of command/args, so anchor the
  // assertion to command's own indentation rather than to any leading space.
  const command = frontmatter.match(/^(\s*)command:\s*node\s*$/m);
  assert.ok(command, 'agent-bridge server entry declares `command: node`');
  const timeout = frontmatter.match(new RegExp(`^${command[1]}timeout:\\s*(\\d+)\\s*$`, 'm'));
  assert.ok(timeout, 'per-server `timeout` declared as a sibling of `command`');

  // It must clear clampWaitSec's 1200s cap (bridge-server/server.mjs) so the
  // bridge always answers before the host abandons the call. The field both
  // raises the per-call wall clock and floors the MCP idle window.
  assert.ok(Number(timeout[1]) > 1200 * 1000,
    `timeout ${timeout[1]}ms must exceed clampWaitSec's 1200s cap`);
});

test('Claude template names itself as the source and SETS the adapter knob', () => {
  // hooks/install-agent.sh regenerates ~/.claude/agents/agent-companion.md from
  // this file on every session start, so the warning has to live where the edit
  // that would be lost gets made.
  assert.match(text, /THIS FILE IS THE SOURCE/);
  assert.match(text, /re-materializes/);

  const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(fm, 'frontmatter block extractable');
  const frontmatter = fm[1];
  assert.match(frontmatter, /takes effect on the NEXT session/);
  // SET, not merely documented — and set as a live `env:` key rather than a
  // commented example. It was documentation-only while the app-server transport
  // was new; it is now the shipped default, because on `exec` a codex job dies
  // with the bridge that started it (measured: probes/smoke/orphan.mjs) and on
  // the app-server it survives (probes/smoke/appserver.mjs).
  //
  // The value itself is asserted against the Codex template's twin in
  // templates/host-parity.test.mjs — this file only checks the Claude host's
  // mechanism, which is a YAML `env:` mapping under the agent-bridge server.
  const active = frontmatter.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  assert.match(active, /^\s{6}env:\s*$/m,
    'the bridge server needs a live `env:` block, not a commented example');
  assert.match(active, /^\s{8}CODEX_RUNTIME_ADAPTER:\s*appserver\s*$/m,
    'the adapter must be a live env key under that block');
});

test('Claude template forbids re-routing a dispatch the bridge refused to route', () => {
  // Reported as "strength advertised but not wired"; forensics showed the
  // bridge answered STRENGTH_UNCONFIGURED in 23ms and the subagent re-sent the
  // task 30s later with target:"codex" — a target the parent never named.
  assert.match(text, /A routing error ≠ permission to pick your own route/);
  for (const code of ROUTING_ERROR_CODES) {
    assert.match(text, new RegExp(`\`${code}\``),
      `${code} named in the no-re-route prohibition`);
  }
  assert.match(text,
    /Do NOT re-send the task with a `target`, `profile`, or `strength` the parent did not supply/);
  assert.match(text, /and do NOT drop the one it did supply/);
});
