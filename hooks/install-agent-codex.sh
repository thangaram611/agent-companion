#!/bin/bash
# install-agent-codex.sh — Codex SessionStart hook
#
# Materializes templates/agent-companion.toml to Codex's user agents directory.
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
# MCP registration is not materialized here. Current Codex intentionally strips
# role MCP overrides, so the subagent inherits the operative registration from
# .codex-plugin/plugin.json.
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

CODEX_DATA_ROOT="${CODEX_HOME:-$HOME/.codex}"
DEST_DIR="$CODEX_DATA_ROOT/agents"
DEST="$DEST_DIR/agent-companion.toml"
SENTINEL="# AUTO-INSTALLED by agent-companion plugin (hooks/install-agent-codex.sh) — edits will be overwritten on next session"

mkdir -p "$DEST_DIR"

# Don't clobber a hand-edited or differently-sourced agent file. Only proceed
# if the destination either doesn't exist or contains our sentinel.
if [ -f "$DEST" ] && ! grep -qF "$SENTINEL" "$DEST"; then
  exit 0
fi

# Materialize: prepend the sentinel as line 1 and copy the role verbatim.
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
if ! {
  printf '%s\n' "$SENTINEL"
  /bin/cat "$TEMPLATE"
} > "$TMP"; then
  exit 0
fi

# Never install a partial render. Without this, a failing stage leaves $TMP
# truncated, `cmp` duly reports "changed", and we would overwrite a working
# agent file with the fragment.
[ -s "$TMP" ] || exit 0

# Atomic update only if content actually changed (avoids spurious file mtime
# bumps on identical writes).
if ! cmp -s "$DEST" "$TMP" 2>/dev/null; then
  mv "$TMP" "$DEST"
  trap - EXIT
fi

exit 0
