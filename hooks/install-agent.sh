#!/bin/bash
# install-agent.sh — SessionStart hook
#
# Installs the agent-companion subagent to ~/.claude/agents/agent-companion.md
# with ${CLAUDE_PLUGIN_ROOT} substituted to its absolute value at install time.
#
# Why we need this: the canonical way to scope an MCP server to a specific
# subagent only (so the parent session never sees it) is the agent's inline
# `mcpServers` frontmatter — but Claude Code silently ignores `mcpServers` /
# `hooks` / `permissionMode` for plugin-shipped agents. The official workaround
# in the docs is to copy the agent into `~/.claude/agents/` (user scope) where
# those fields are honored. This hook automates that copy on every session
# start, idempotently.
#
# After this runs, the standalone agent at ~/.claude/agents/agent-companion.md
# spawns the bridge MCP server inline ONLY when the subagent is invoked. Main
# Claude has no `mcp__agent-bridge__copilot_*` in its tool surface — there is
# no plugin-level .mcp.json registration anywhere.
#
# Idempotent, but not short-circuited: there is no checksum and no fast path.
# Every session regenerates the file in full (template → sentinel → path and
# node substitution) and byte-compares it against the destination, replacing it
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

# Resolve an absolute path to a `node` binary so the MCP frontmatter's
# `command:` field doesn't depend on whatever PATH Claude Code inherits.
# This matters for nvm / mise / asdf users: their `node` is a shell function
# or shim only loadable via shell init. Claude Code spawns the MCP server
# via `child_process.spawn(command, args)` directly — NO shell, so
# .zshenv/.bashrc/etc are never sourced for that spawn. The spawn fails
# and the tool surfaces as "not available in this environment".
#
# The resolution order and the stripped-env validation that canonicalizes shims
# to their underlying binary both live in hooks/node-tools.sh. This script used
# to carry its own hand-copy of that logic; the copy drifted and lost the
# AGENT_COMPANION_NODE override, so the one escape hatch a user has when
# auto-detection picks the wrong Node silently did nothing here. Sourcing the
# shared resolver is the only way that stays fixed.
#
# If nothing resolves, leave the template's literal `node` in place.
TOOLS="$ROOT/hooks/node-tools.sh"
NODE_BIN=""
if [ -r "$TOOLS" ]; then
  # shellcheck source=/dev/null
  . "$TOOLS"
  NODE_BIN="$(resolve_node 2>/dev/null || true)"
fi

# Materialize: insert sentinel as a YAML-comment line right after the opening
# `---` of the frontmatter, substitute ${CLAUDE_PLUGIN_ROOT}, and (if we
# resolved one) rewrite `command: node` → absolute path so the MCP server
# spawn doesn't depend on PATH. awk insertion preserves the file starting
# with `---` so Claude Code's frontmatter parser sees a valid YAML block.
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
SED_ROOT="$(printf '%s' "$ROOT" | sed 's/[\/&|]/\\&/g')"

# The node rewrite is anchored to the YAML pattern (whitespace + `command:` +
# space + `node` + end-of-line) so it can't touch `command:` fields outside the
# MCP block, and is a no-op if the template ever switches to an absolute path.
# When no node resolved it degrades to an expression that matches nothing, which
# keeps this a single pipeline — the previous second-temp-file dance leaked a
# /tmp file whenever the script was killed mid-rewrite.
NODE_SED='s|^$||'
if [ -n "$NODE_BIN" ]; then
  SED_NODE_BIN="$(printf '%s' "$NODE_BIN" | sed 's/[\/&|]/\\&/g')"
  NODE_SED="s|^\([[:space:]]*command:\) node[[:space:]]*\$|\1 ${SED_NODE_BIN}|"
fi

set -o pipefail
awk -v sentinel="$SENTINEL" 'NR==1 { print; print sentinel; next } { print }' "$TEMPLATE" \
  | sed "s|\${CLAUDE_PLUGIN_ROOT}|$SED_ROOT|g" \
  | sed "$NODE_SED" \
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
