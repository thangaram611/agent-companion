#!/bin/bash
# name-thread.sh — PreToolUse hook on agent_send (Claude Code only)
#
# One agent-companion instance is one companion conversation. Claude Code gives
# every subagent instance an `agent_id` that survives SendMessage continuation,
# but shows it only to hooks: the MCP server sees just the main session id
# (measured on Claude Code 2.1.310). So this hook writes the calling subagent's
# agent_id into the send's `thread`, over anything the model put there. Codex
# needs no hook — the bridge reads the caller's own thread id from MCP _meta.
#
# A call with no agent_id (main) passes through untouched, and the bridge then
# refuses the send for want of a thread. So does a missing node: the hook exits
# 0 so the call still reaches the bridge, whose refusal names this script.

ROOT="${CLAUDE_PLUGIN_ROOT:-}"
TOOLS="$ROOT/hooks/node-tools.sh"
if [ -r "$TOOLS" ]; then
  # shellcheck source=/dev/null
  . "$TOOLS"
fi
NODE_BIN="$(resolve_node 2>/dev/null || true)"
[ -n "$NODE_BIN" ] || { echo "agent-companion: node not found; agent_send goes out without a thread" >&2; exit 0; }

exec "$NODE_BIN" -e '
const { agent_id: id, tool_input: input } = JSON.parse(require("fs").readFileSync(0, "utf8"));
if (id) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...input, thread: id } } }));
'
