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

test('Claude role names all five companions and explains Claude continuity', () => {
  const parent = description.replace(/\s+/g, ' ');
  for (const companion of ['Codex', 'OpenCode', 'Antigravity', 'Copilot', 'Claude Code']) {
    assert.ok(parent.includes(companion), `${companion} must be discoverable`);
  }
  assert.match(parent, /when the user names Claude or wants Claude Code's own answer/);
  assert.match(parent, /Claude Code host can delegate to a Claude Code companion/);
  assert.match(parent, /separate process with the user's own Claude login and cannot delegate through Agent Companion again/);
  assert.match(prose, /Codex, OpenCode and Claude Code follow-ups resume saved conversations cold/);
  assert.match(prose, /In-flight replies are only for Codex/);
  assert.match(prose, /running Claude Code job is refused with `reply_unavailable`; tell the parent to wait or cancel/);
  assert.match(prose, /Send every follow-up to the companion through `agent_send`, even when the earlier reply seems to answer it already/);
  assert.match(prose, /A different companion is a new conversation: this thread stays bound to the companion that started it/);
  assert.match(prose, /refused with `provider_mismatch`\. Do not retry it here\. Tell the parent to spawn a new agent-companion/);
  assert.doesNotMatch(description + body, /stream-json|stdio|--resume|thread\/resume|session\/load|\btransport\b/i);
});

test('Claude role uses the catalog for an open choice and sends only the new fields', () => {
  assert.match(prose, /Honour an explicit companion or model/);
  assert.match(prose, /read .*agent_catalog` once and choose a companion that is ready/);
  assert.match(prose, /leave the model to the companion's own configuration unless the parent asked for one/);
  assert.match(prose, /ownerless and read-only/);
  assert.match(prose, /enabled companions.*default companion.*model configuration.*capabilities.*readiness.*last check/);
  assert.match(prose, /not enumerable without a session/);
  assert.match(prose, /ask the parent.*do not guess/);
  assert.match(prose, /`task` and `cwd`, plus optional `target`, `model`, `effort` and `max_wait_sec`/);
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
  assert.match(prose, /per-job status carries `action: "status"` but no terminal `content` \+ `meta`/);
  assert.match(prose, /fields the response supplies; never emit `undefined`/);
  for (const field of ['meta.digest_uri', 'resource_link', 'meta.usage', 'meta.debug_digest_path', 'meta.detail']) {
    assert.ok(body.includes(field), `${field} must reach the parent`);
  }
  assert.match(prose, /Orphan events surfaced during this turn/);
  assert.match(prose, /include them as-is above your answer/);
  assert.match(prose, /agent_status` with `diagnostics: true` first/);
});

test('Claude references the plugin session server by name and preserves its budget and env', () => {
  const manifest = JSON.parse(readFileSync(join(HERE, '..', '.claude-plugin/plugin.json'), 'utf8'));
  const server = manifest.mcpServers?.['agent-bridge'];
  assert.ok(server, 'Claude plugin must register the session server');
  assert.match(frontmatter, /^mcpServers: \[agent-bridge\]$/m);
  assert.doesNotMatch(frontmatter, /^\s+(command|args|timeout|env):/m);
  assert.equal(server.type, 'stdio');
  assert.equal(server.command, '/bin/bash');
  assert.deepEqual(server.args, ['${CLAUDE_PLUGIN_ROOT}/hooks/launch-agent-bridge.sh']);
  assert.equal(server.timeout, 1320000);
  assert.ok(server.timeout > 1200 * 1000);
  assert.equal(server.env.MCP_TOOL_TIMEOUT, undefined);
  assert.equal(server.env.AGENT_COMPANION_OWNER_GRACE_MS, '120000');
  assert.match(text, /THIS FILE IS THE SOURCE/);
  assert.match(text, /re-materializes/);
});

test('Claude role relays routing and unsupported-follow-up refusals and leaves failed work with the companion', () => {
  assert.deepEqual([...new Set(body.match(/\b[A-Z]+_[A-Z_]+\b/g))].sort(), [
    'CAPABILITY_UNAVAILABLE', 'EFFORT_NOT_ALLOWED', 'FOLLOWUP_UNSUPPORTED', 'MODEL_NOT_ALLOWED', 'TARGET_UNCONFIGURED', 'TARGET_UNSUPPORTED',
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
  assert.match(prose, /resumes the saved conversation in a new process/);
  assert.match(prose, /Copilot follow-ups are refused with `FOLLOWUP_UNSUPPORTED`/);
  assert.match(prose, /Bridge loss stops the owned provider tree and keeps history/);
  assert.match(prose, /`agent_reply` steers only where capabilities.*`reply_unavailable`/);
  assert.doesNotMatch(prose, /single-shot adapters|daemon no longer holds/);
});

test('Claude role preserves bounded waits, per-job reply checks and cancel acknowledgement handling', () => {
  assert.match(prose, /numeric `max_wait_sec`.*480.*\[1,1200\]/);
  assert.match(prose, /Remember it as `BUDGET`.*same `BUDGET` for every wait/);
  assert.match(prose, /identical.*in-flight.*reattaches.*BUDGET/);
  assert.match(prose, /different `task`, `model` or `effort`.*thread_busy/);
  assert.equal(body.match(/Loop iter N: job <job_id> still running, re-waiting\./g)?.length, 1);
  assert.match(prose, /exactly one line/);
  assert.match(prose, /Keep looping until terminal.*no iteration cap/i);
  assert.match(prose, /SendMessage arrivals.*only between waits/);
  assert.match(prose, /interrupt latency is one `BUDGET`/);
  assert.match(prose, /agent_status.*job_id.*reply_available: true.*that job/);
  assert.match(prose, /per-job fact/);
  assert.match(prose, /do not cancel-and-resend to fake a reply/);
  assert.match(prose, /reply_unavailable/);
  assert.match(prose, /no tracked job to cancel/);
  assert.match(prose, /`cancelling`.*same `BUDGET` until terminal/);
});

test('role passes named effort and relays launch metadata and running activity', () => {
  assert.match(prose, /use Claude with low effort/);
  assert.match(prose, /Codex, high effort/);
  assert.match(prose, /Pass `model` and `effort` on `agent_send` only when named/);
  assert.match(prose, /catalog lists each companion's effort levels/);
  assert.match(prose, /unsupported effort is refused/);
  assert.match(prose, /When the job starts, relay `effective_model`, `selected_effort` and `permission_mode`/);
  assert.match(prose, /reporting a running job, relay `activity`/);
  assert.match(prose, /still thinking.*running <cmd>/);
});
