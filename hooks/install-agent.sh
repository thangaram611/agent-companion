#!/bin/bash
# install-agent.sh — SessionStart hook
#
# Installs the agent-companion subagent to ~/.claude/agents/agent-companion.md
# referencing the plugin/session MCP server by its registered name. Claude
# ignores mcpServers on plugin-shipped agents, so the user-scoped copy remains
# necessary even though the server now belongs to the session. The parent sees
# its tools; the bridge refuses owner-bound calls without a native child owner.
#
# Idempotent, but not short-circuited: there is no checksum and no fast path.
# Every session regenerates the file in full (template → sentinel → plugin
# namespace) and byte-compares it against the destination, replacing it
# only if they differ. So the destination's mtime is stable across no-op runs,
# which is all that matters here — Claude Code hot-reloads agents on mtime.
#
# Deliberately no freshness check to skip the regeneration: the only cheap
# signal available is comparing the template's mtime against the destination's,
# and plugin upgrades arrive via tar / `cp -p` / `rsync -a`, all of which
# preserve the source's original timestamps. A newer template can easily land
# with an older mtime than the file it replaces, and the check would then skip
# the update that mattered. Regenerating unconditionally costs a few subprocess
# spawns and cannot be wrong.
#
# Sentinel-guarded: leaves alone any user-authored agent file at the same
# path (no auto-generated header → don't touch).
#
# Sentinel placement: must be INSIDE the YAML frontmatter as a `# ...` comment,
# not above the leading `---`. Claude Code's agent discovery requires the file
# to START with `---`; anything before that (HTML comment, blank line) makes
# the parser drop the file from /agents listing. We insert the sentinel as
# line 2, right after the opening `---`.

ROOT="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}"
[ -n "$ROOT" ] || exit 0

TEMPLATE="$ROOT/templates/agent-companion.md"
[ -f "$TEMPLATE" ] || exit 0

DEST_DIR="$HOME/.claude/agents"
DEST="$DEST_DIR/agent-companion.md"
SENTINEL="# AUTO-INSTALLED by agent-companion plugin (hooks/install-agent.sh) — edits will be overwritten on next session"

mkdir -p "$DEST_DIR"

# Don't clobber a hand-edited or differently-sourced agent file. Only proceed
# if the destination either doesn't exist or contains our sentinel.
if [ -f "$DEST" ] && ! grep -qF "$SENTINEL" "$DEST"; then
  exit 0
fi

# Materialize the short source reference using Claude Code's plugin namespace.
# The launcher owns Node resolution now that transport is session-scoped.
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

set -o pipefail
awk -v sentinel="$SENTINEL" 'NR==1 { print; print sentinel; next } { print }' "$TEMPLATE" \
  | sed 's|^mcpServers: \[agent-bridge\]$|mcpServers: [plugin:agent-companion:agent-bridge]|; s|mcp__agent-bridge__|mcp__plugin_agent-companion_agent-bridge__|g' \
  > "$TMP"
RENDER_STATUS=$?
set +o pipefail

# Never install a partial render. Without this, a failing stage leaves $TMP
# truncated, `cmp` duly reports "changed", and we would overwrite a working
# agent file with the fragment.
[ "$RENDER_STATUS" -eq 0 ] || exit 0
[ -s "$TMP" ] || exit 0

# Atomic update only if content actually changed (avoids spurious file mtime
# bumps and Claude Code's hot-reload churn on identical writes).
if ! cmp -s "$DEST" "$TMP" 2>/dev/null; then
  mv "$TMP" "$DEST"
  trap - EXIT
fi

exit 0
