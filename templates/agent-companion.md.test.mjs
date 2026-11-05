import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const text = readFileSync(join(HERE, 'agent-companion.md'), 'utf8');

const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/)[1];
const description = frontmatter.match(/^description: \|\n([\s\S]*?)^model:/m)[1];
const body = text.slice(text.indexOf('\n---\n') + 5);
const prose = body.replace(/\s+/g, ' ');

test('Claude role accepts plain language and keeps the seven instruction sections in order', () => {
  assert.match(description, /plain language/);
  assert.match(description, /absolute repo or worktree path/);
  assert.match(description, /optionally which companion or model/);
  assert.match(description, /SendMessage.*same subagent/s);
  assert.match(description, /new one for independent work/);
  assert.match(description, /run_in_background: true/);
  assert.deepEqual([...body.matchAll(/^# (.+)$/gm)].map((m) => m[1]), [
    'Identity', 'Choosing', 'Sending', 'Waiting', 'Answering', 'When it fails', 'Diagnostics',
  ]);
  // Source/install comments may name templates/. Active instructions may not
  // teach the retired protocol, including in the parent-facing description.
  const active = `${description}\n${body}`;
  assert.doesNotMatch(active, /JSON|payload|\b(?:templates?|modes?|strengths?|profiles?|verdicts?|fleet|parallel)\b|rubber.duck|router,? not a worker/i);
  assert.doesNotMatch(active, /"(?:action|task|target|cwd)"\s*:/);
  assert.match(prose, /The companion does the work/);
});

test('Claude role uses the catalog for an open choice and sends only the new fields', () => {
  assert.match(prose, /Honour an explicit companion or model/);
  assert.match(prose, /read .*agent_catalog` once and choose a companion that is ready/);
  assert.match(prose, /leave the model to the companion's own configuration unless the parent asked for one/);
  assert.match(prose, /ownerless and read-only/);
  assert.match(prose, /enabled companions.*default companion.*model configuration.*capabilities.*readiness.*last check/);
  assert.match(prose, /not enumerable without a session/);
  assert.match(prose, /ask the parent.*do not guess/);
  assert.match(prose, /`task` and `cwd`, plus optional `target`, `model` and `max_wait_sec`/);
  assert.match(prose, /bridge delivers `task` verbatim/);
  assert.match(prose, /Omit `model` to inherit/);
  const tools = frontmatter.match(/^tools: (.+)$/m)[1].split(', ');
  assert.deepEqual(tools, [
    ...['catalog', 'send', 'wait', 'status', 'reply', 'cancel'].map((name) => `mcp__agent-bridge__agent_${name}`),
    'Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'WebFetch', 'TodoWrite',
  ]);
  assert.match(frontmatter, /^model: sonnet$/m);
});

test('Claude role relays answers, status, metadata and orphan events without requiring an answer format', () => {
  assert.match(prose, /Return the companion's answer as the companion gave it/);
  assert.match(prose, /own observations under a separate.*Observations/);
  assert.match(prose, /asked a question, relay it/);
  assert.match(prose, /Report success only after the bridge reports `completed`/);
  assert.match(prose, /per-job status has no `action`/);
  assert.match(prose, /fields the response supplies; never emit `undefined`/);
  for (const field of ['meta.digest_uri', 'resource_link', 'meta.usage', 'meta.debug_digest_path', 'meta.detail', 'failure_class', 'session_retired']) {
    assert.ok(body.includes(field), `${field} must reach the parent`);
  }
  assert.match(prose, /Orphan events surfaced during this turn/);
  assert.match(prose, /include them as-is above your answer/);
  assert.match(prose, /agent_status` with `diagnostics: true` first/);
});

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
  // The value itself is asserted against the Codex manifest's twin in
  // templates/host-parity.test.mjs — this file only checks the Claude host's
  // mechanism, which is a YAML `env:` mapping under the agent-bridge server.
  const active = frontmatter.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  assert.match(active, /^\s{6}env:\s*$/m,
    'the bridge server needs a live `env:` block, not a commented example');
  assert.match(active, /^\s{8}CODEX_RUNTIME_ADAPTER:\s*appserver\s*$/m,
    'the adapter must be a live env key under that block');
});

test('Claude role relays the four refusals and leaves failed work with the companion', () => {
  assert.deepEqual([...new Set(body.match(/\b[A-Z]+_[A-Z_]+\b/g))].sort(), [
    'CAPABILITY_UNAVAILABLE', 'MODEL_NOT_ALLOWED', 'TARGET_UNCONFIGURED', 'TARGET_UNSUPPORTED',
  ]);
  assert.match(prose, /Relay a refusal verbatim and stop; never work around it/);
  assert.match(prose, /The delegated task itself stays with the companion/);
  assert.match(prose, /do not complete it yourself or switch to a companion or model the parent did not allow/);
  assert.match(prose, /read files to check one specific suspect finding/);
  assert.match(prose, /actual terminal state.*failed.*timeout.*cancelled.*stuck.*unreachable/);
  assert.match(prose, /partial output and digest link/);
  assert.match(prose, /If a bridge call throws, retry once/);
  assert.match(prose, /two consecutive calls throw, take one log tail/);
  assert.match(prose, /last 20 lines.*~\/.claude\/agent-companion\/runtime\/agent-bridge\.log/);
  assert.match(prose, /\(log file not found\)/);
  assert.match(prose, /`mcp_unreachable`.*stop/);
  assert.match(prose, /missing.*skip the log tail.*stop/);
  assert.match(prose, /response-level `timeout` or `unreachable`.*without a log tail/);
});

// One agent-companion instance is one companion conversation, and the host
// names it (hooks/name-thread.sh writes the subagent's agent_id into `thread`),
// so the subagent carries no thread and main learns spawn-vs-continue instead.
test('Claude template leaves thread and session id to the host: a spawn starts a conversation, SendMessage continues it', () => {
  assert.doesNotMatch(text, /MY_THREAD/);
  // Nor a session id: the bridge inherits CLAUDE_CODE_SESSION_ID from Claude Code.
  assert.doesNotMatch(text, /host_session_id|CLAUDE_CODE_SESSION_ID/);
  assert.doesNotMatch(text, /"thread":/);
  assert.match(prose, /Thread continuity — named by the host/);
  assert.match(prose, /hooks\/name-thread.sh.*agent id/);
  assert.match(prose, /SendMessage.*keeps that id/);
  assert.match(prose, /new spawn.*new id/);
  assert.match(prose, /single-shot adapters.*no in-process conversation/s);
  assert.match(prose, /resume_available/);
});

test('Claude role preserves bounded waits, per-job reply checks and cancel acknowledgement handling', () => {
  assert.match(prose, /numeric `max_wait_sec`.*480.*\[1,1200\]/);
  assert.match(prose, /Remember it as `BUDGET`.*same `BUDGET` for every wait/);
  assert.match(prose, /identical.*in-flight.*reattaches.*BUDGET/);
  assert.match(prose, /different `task` or `model`.*thread_busy/);
  assert.equal(body.match(/Loop iter N: job <job_id> still running, re-waiting\./g)?.length, 1);
  assert.match(prose, /exactly one line/);
  assert.match(prose, /Keep looping until terminal.*no iteration cap/i);
  assert.match(prose, /SendMessage arrivals.*only between waits/);
  assert.match(prose, /interrupt latency is one `BUDGET`/);
  assert.match(prose, /agent_status.*job_id.*reply_available: true.*that job/);
  assert.match(prose, /per-job fact/);
  assert.match(prose, /do not cancel-and-resend to fake a reply/);
  assert.match(prose, /ACP.*cancelled turn plus a new prompt/);
  assert.match(prose, /no tracked job to cancel/);
  assert.match(prose, /`cancelling`.*same `BUDGET` until terminal/);
});
