// Codex roles inherit MCP authority from the plugin manifest. Host parity
// checks the operative configuration; this suite pins the role schema and text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const text = readFileSync(join(HERE, 'agent-companion.toml'), 'utf8');
const description = text.match(/^description\s*=\s*"""([\s\S]*?)"""/m)[1];
const body = text.match(/^developer_instructions\s*=\s*"""([\s\S]*?)"""/m)[1];
const prose = body.replace(/\s+/g, ' ');

test('Codex role accepts plain language and keeps the seven instruction sections in order', () => {
  assert.match(description, /plain language/);
  assert.match(description, /absolute repo or worktree path/);
  assert.match(description, /optionally which companion or model/);
  assert.match(description, /followup_task.*same subagent/s);
  assert.match(description, /new one for independent work/);
  assert.match(description, /long work in the background/);
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

test('Codex role pins low reasoning effort and inherits the parent model', () => {
  assert.match(text, /^model_reasoning_effort = "low"$/m);
  assert.doesNotMatch(text, /^model = /m, 'the relay inherits the parent model');
});

test('Codex role names all five companions and explains Claude continuity', () => {
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

test('Codex role uses the catalog for an open choice and sends only the new fields', () => {
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
});

test('Codex role relays answers, status, metadata and orphan events without requiring an answer format', () => {
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

test('Codex role relays routing and unsupported-follow-up refusals and leaves failed work with the companion', () => {
  assert.deepEqual([...new Set(body.match(/\b[A-Z]+_[A-Z_]+\b/g))].filter((code) => code !== 'ALL_TOOLS').sort(), [
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
  assert.match(prose, /last 20 lines.*~\/.codex\/agent-companion\/runtime\/agent-bridge\.log/);
  assert.match(prose, /\(log file not found\)/);
  assert.match(prose, /`mcp_unreachable`.*stop/);
  assert.match(prose, /missing.*skip the log tail.*stop/);
  assert.match(prose, /response-level `timeout` or `unreachable`.*without a log tail/);
});

test('Codex role preserves bounded waits, per-job reply checks and cancel acknowledgement handling', () => {
  assert.match(prose, /numeric `max_wait_sec`.*480.*\[1,1200\]/);
  assert.match(prose, /Remember it as `BUDGET`.*same `BUDGET` for every wait/);
  assert.match(prose, /identical.*in-flight.*reattaches.*BUDGET/);
  assert.match(prose, /different `task`, `model` or `effort`.*thread_busy/);
  assert.equal(body.match(/Loop iter N: job <job_id> still running, re-waiting\./g)?.length, 1);
  assert.match(prose, /exactly one line/);
  assert.match(prose, /Keep looping until terminal.*no iteration cap/i);
  assert.match(prose, /followup_task.*send_message arrivals.*only between waits/);
  assert.match(prose, /interrupt latency is one `BUDGET`/);
  assert.match(prose, /agent_status.*job_id.*reply_available: true.*that job/);
  assert.match(prose, /per-job fact/);
  assert.match(prose, /do not cancel-and-resend to fake a reply/);
  assert.match(prose, /reply_unavailable/);
  assert.match(prose, /no tracked job to cancel/);
  assert.match(prose, /`cancelling`.*same `BUDGET` until terminal/);
});

test('Codex role uses only supported top-level fields and inherits the session model with low effort', () => {
  const topLevel = text.replace(/"""[\s\S]*?"""/g, '""');
  assert.deepEqual([...topLevel.matchAll(/^(\w+)\s*=/gm)].map((m) => m[1]), [
    'name', 'model_reasoning_effort', 'description', 'developer_instructions',
  ]);
  assert.match(topLevel, /^name\s*=\s*"agent-companion"\s*$/m);
  assert.doesNotMatch(topLevel, /^\s*\[/m, 'role-local tables cannot add MCP authority');
  assert.doesNotMatch(text, /\$\{CLAUDE_PLUGIN_ROOT\}|MCP_TOOL_TIMEOUT|CLAUDE_CODE_SESSION_ID/);
  assert.doesNotMatch(description + body, /\\/, 'plain text needs no TOML string escapes');
});

test('Codex role lists six normalized tools and checks deferred discovery before declaring one missing', () => {
  const names = [...new Set(body.match(/mcp__agent_bridge__agent_[a-z]+/g))].sort();
  assert.deepEqual(names, ['cancel', 'catalog', 'reply', 'send', 'status', 'wait']
    .map((name) => `mcp__agent_bridge__agent_${name}`));
  assert.match(prose, /tools\.mcp__agent_bridge__agent_catalog/);
  assert.match(prose, /one awaited.*call per `functions.exec`/);
  assert.match(prose, /ALL_TOOLS.*exact normalized name/);
  assert.match(prose, /Absence from the top-level schema is expected/);
  assert.doesNotMatch(text, /mcp__agent-bridge__/);
});

test('Codex host names the conversation and parent controls remain natural messages', () => {
  assert.doesNotMatch(text, /by-host-session|MY_THREAD|host_session_id|"thread":/);
  assert.match(prose, /Thread continuity — named by the host/);
  assert.match(prose, /Codex sends your own thread id in MCP `_meta`/);
  assert.match(prose, /followup_task.*send_message.*keeps that id/);
  assert.match(prose, /new spawn.*new id/);
  assert.match(prose, /resumes the saved conversation in a new process/);
  assert.match(prose, /Copilot follow-ups are refused with `FOLLOWUP_UNSUPPORTED`/);
  assert.match(prose, /Bridge loss stops the owned provider tree and keeps history/);
  assert.match(prose, /`agent_reply` steers only where capabilities.*`reply_unavailable`/);
  assert.doesNotMatch(prose, /single-shot adapters|daemon no longer holds/);
  const parent = description.replace(/\s+/g, ' ');
  assert.match(parent, /spawn_agent.*`task_name`.*`agent_type`.*`message`/);
  assert.match(parent, /followup_task.*`target`.*`message`/);
  assert.match(parent, /wait_agent.*`timeout_ms`/);
  assert.match(parent, /send_message.*does not trigger a new turn/);
  assert.match(parent, /list_agents/);
  assert.match(parent, /interrupt_agent.*does not cancel the companion job/);
  assert.doesNotMatch(text, /send_input|resume_agent|trigger_turn|\bAgent\(\)|SendMessage\(\)/);
});

test('role passes named effort and relays launch metadata and running activity', () => {
  assert.match(prose, /use Claude with low effort/);
  assert.match(prose, /Codex, high effort/);
  assert.match(prose, /Pass `model` and `effort` on `agent_send` only when named/);
  assert.match(prose, /catalog describes effort selection; Codex levels\s+depend on the model and are checked at send/);
  assert.match(prose, /unsupported effort is refused/);
  assert.match(prose, /When the job starts, relay `effective_model`, `selected_effort` and `permission_mode`/);
  assert.match(prose, /reporting a running job, relay `activity`/);
  assert.match(prose, /still thinking.*running <cmd>/);
});
