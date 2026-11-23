#!/bin/bash
# Prepare an isolated OpenCode host run with the fake job server registered. Usage: prepare.sh NAME  → prints RUN
HERE="$(cd "$(dirname "$0")/.." && pwd -P)"
RUN="$HERE/runs/$1-$(date -u +%Y-%m-%dT%H-%M-%S)"
mkdir -p "$RUN/home/.config/opencode" "$RUN/home/.local/share/opencode" "$RUN/home/.local/state" "$RUN/home/.cache" "$RUN/tmp" "$RUN/workspace"
NODE="$(command -v node)"
cat > "$RUN/workspace/opencode.json" <<JSON
{ "\$schema": "https://opencode.ai/config.json",
  "mcp": { "fixture": { "type": "local", "command": ["$NODE", "$HERE/fixture.mjs", "$RUN"], "enabled": true } } }
JSON
cat > "$RUN/env.sh" <<ENV
export PATH="$PATH" HOME="$RUN/home" TMPDIR="$RUN/tmp" LANG=en_US.UTF-8 XDG_CONFIG_HOME="$RUN/home/.config" XDG_DATA_HOME="$RUN/home/.local/share" XDG_STATE_HOME="$RUN/home/.local/state" XDG_CACHE_HOME="$RUN/home/.cache" OPENCODE_DB="$RUN/home/.local/share/opencode/opencode.db"
ENV
echo "$RUN"
