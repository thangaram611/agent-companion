#!/bin/bash
# Only Claude's hook sees both the session and the native agent id.
ROOT="${CLAUDE_PLUGIN_ROOT:-}"
TOOLS="$ROOT/hooks/node-tools.sh"
if [ -r "$TOOLS" ]; then
  # shellcheck source=/dev/null
  . "$TOOLS"
fi
NODE_BIN="$(resolve_node 2>/dev/null || true)"
deny_lead() {
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"LEAD_REQUIRED: the lead identity hook could not run"}}'
}
[ -n "$NODE_BIN" ] || { deny_lead; exit 0; }

"$NODE_BIN" -e '
const { session_id: session, agent_id: agent = null, tool_input: input } = JSON.parse(require("fs").readFileSync(0, "utf8"));
const lead = { session, agent };
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...input, lead } } }));
' || deny_lead
