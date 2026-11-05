#!/bin/bash
# name-thread.sh — PreToolUse hook on owner-bound tools (Claude Code only)
#
# One agent-companion instance is one companion conversation. Claude Code gives
# every subagent instance an `agent_id` that survives SendMessage continuation,
# but shows it only to hooks: the MCP server sees just the main session id
# (measured on Claude Code 2.1.310). So this hook writes the calling subagent's
# agent_id into every owner call's `thread`, over anything the model put there. Codex
# needs no hook — the bridge reads the caller's own thread id from MCP _meta.
#
# With no agent_id, clear thread even if the model supplied one. If the rewrite
# cannot run, deny the call: passing through would preserve a forged owner.

ROOT="${CLAUDE_PLUGIN_ROOT:-}"
TOOLS="$ROOT/hooks/node-tools.sh"
if [ -r "$TOOLS" ]; then
  # shellcheck source=/dev/null
  . "$TOOLS"
fi
NODE_BIN="$(resolve_node 2>/dev/null || true)"
deny_owner() {
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"NATIVE_OWNER_REQUIRED: the native owner hook could not run"}}'
}
[ -n "$NODE_BIN" ] || { deny_owner; exit 0; }

"$NODE_BIN" -e '
const { agent_id: id, tool_input: input } = JSON.parse(require("fs").readFileSync(0, "utf8"));
const thread = typeof id === "string" && id.trim() ? id : "";
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...input, thread } } }));
' || deny_owner
