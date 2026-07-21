#!/bin/bash
# install-agent-codex.sh — Codex SessionStart hook
#
# Materializes templates/agent-companion.toml to ~/.codex/agents/agent-companion.toml
# with ${CLAUDE_PLUGIN_ROOT} substituted to its absolute value at install time.
#
# Why we need this: Codex's `RawPluginManifest` has NO `agents` field — Codex
# loads subagents only from ~/.codex/agents/ (and per-project .codex/agents/).
# So plugin-bundled subagents must be materialized at install time, then
# kept fresh on every SessionStart in case the plugin upgraded.
#
# This script is the Codex sibling of hooks/install-agent.sh. The Codex
# version differs in three ways:
#   1. Output format is .toml (not .md with YAML frontmatter).
#   2. Sentinel placement: just a `# comment` line at the very top of the
#      file. TOML parsers ignore lines starting with `#`. Unlike the Claude
#      version we don't need to thread it INTO a frontmatter block — TOML
#      has no frontmatter / no required leading delimiter, so a comment on
#      line 1 is fine.
#   3. ${CLAUDE_PLUGIN_ROOT} substitution happens here too — Codex MCP
#      `args` strings are LITERALS at runtime (no `${VAR}` expansion), so
#      the only chance we get to bake the absolute path into the agent's
#      MCP server config is at materialization time.
#
# Idempotent, but not short-circuited: there is no checksum and no fast path.
# Every session regenerates the file in full and byte-compares it against the
# destination, replacing it only if they differ, so no-op runs leave the
# destination's mtime alone. See hooks/install-agent.sh for why there is no
# mtime-based freshness check to skip the regeneration (plugin upgrades arrive
# via tar / `cp -p` / `rsync -a`, which preserve older source timestamps).
#
# Sentinel-guarded: leaves alone any user-authored agent file at the same
# path (no auto-generated header → don't touch).

ROOT="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}"
[ -n "$ROOT" ] || exit 0

TEMPLATE="$ROOT/templates/agent-companion.toml"
[ -f "$TEMPLATE" ] || exit 0

DEST_DIR="$HOME/.codex/agents"
DEST="$DEST_DIR/agent-companion.toml"
SENTINEL="# AUTO-INSTALLED by agent-companion plugin (hooks/install-agent-codex.sh) — edits will be overwritten on next session"

mkdir -p "$DEST_DIR"

# Don't clobber a hand-edited or differently-sourced agent file. Only proceed
# if the destination either doesn't exist or contains our sentinel.
if [ -f "$DEST" ] && ! grep -qF "$SENTINEL" "$DEST"; then
  exit 0
fi

# Resolve an absolute path to a `node` binary. Resolution order (type -P →
# recursive nvm default alias → highest nvm version by sort -V → common system
# paths), the AGENT_COMPANION_NODE override, and the stripped-env validation
# that canonicalizes shim paths (mise/asdf) to the underlying binary all live in
# hooks/node-tools.sh. This script and hooks/install-agent.sh both used to carry
# hand-copies with a "keep these in sync" comment; they did not stay in sync,
# and both silently dropped the AGENT_COMPANION_NODE override.
TOOLS="$ROOT/hooks/node-tools.sh"
NODE_BIN=""
if [ -r "$TOOLS" ]; then
  # shellcheck source=/dev/null
  . "$TOOLS"
  NODE_BIN="$(resolve_node 2>/dev/null || true)"
fi

# Materialize: prepend the sentinel as line 1, then substitute
# ${CLAUDE_PLUGIN_ROOT} in the body. The substitution targets the literal
# token inside `mcp_servers.agent-bridge.args` so the bridge launcher gets
# an absolute path at runtime. If we resolved a node binary, also rewrite
# `command = "node"` to its absolute path so the MCP spawn doesn't depend
# on PATH.
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
SED_ROOT="$(printf '%s' "$ROOT" | sed 's/[\/&|]/\\&/g')"

# The node rewrite is anchored to the TOML pattern (`command = "node"` at line
# start, optional surrounding whitespace) so it can't touch other literals, and
# is a no-op if the template ever switches to an absolute path. With no node
# resolved it degrades to an expression matching nothing, keeping this a single
# pipeline — the previous second-temp-file dance leaked a /tmp file whenever the
# script was killed mid-rewrite.
NODE_SED='s|^$||'
if [ -n "$NODE_BIN" ]; then
  SED_NODE_BIN="$(printf '%s' "$NODE_BIN" | sed 's/[\/&|]/\\&/g')"
  NODE_SED="s|^\([[:space:]]*command[[:space:]]*=[[:space:]]*\)\"node\"[[:space:]]*\$|\1\"${SED_NODE_BIN}\"|"
fi

set -o pipefail
{
  printf '%s\n' "$SENTINEL"
  sed "s|\${CLAUDE_PLUGIN_ROOT}|$SED_ROOT|g" "$TEMPLATE"
} | sed "$NODE_SED" > "$TMP"
RENDER_STATUS=$?
set +o pipefail

# Never install a partial render. Without this, a failing stage leaves $TMP
# truncated, `cmp` duly reports "changed", and we would overwrite a working
# agent file with the fragment.
[ "$RENDER_STATUS" -eq 0 ] || exit 0
[ -s "$TMP" ] || exit 0

# Atomic update only if content actually changed (avoids spurious file mtime
# bumps on identical writes).
if ! cmp -s "$DEST" "$TMP" 2>/dev/null; then
  mv "$TMP" "$DEST"
  trap - EXIT
fi

exit 0
