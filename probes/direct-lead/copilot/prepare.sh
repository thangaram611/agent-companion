#!/bin/bash
# Prepare an isolated Copilot CLI host run against the scripted model. Usage: prepare.sh NAME → prints RUN
HERE="$(cd "$(dirname "$0")/.." && pwd -P)"
RUN="$HERE/runs/$1-$(date -u +%Y-%m-%dT%H-%M-%S)"
mkdir -p "$RUN/home" "$RUN/copilot-home" "$RUN/tmp" "$RUN/workspace"
NODE="$(command -v node)"
nohup "$NODE" "$HERE/codex/fake-model.mjs" "$RUN" > "$RUN/fake-model.log" 2>&1 &
echo $! > "$RUN/fake-model.pid"
for i in $(seq 1 50); do [ -s "$RUN/model-port.txt" ] && break; perl -e 'select(undef,undef,undef,0.1)'; done
PORT="$(cat "$RUN/model-port.txt")"
cat > "$RUN/mcp.json" <<JSON
{ "mcpServers": { "fixture": { "type": "local", "command": "$NODE", "args": ["$HERE/fixture.mjs", "$RUN"], "tools": ["*"] } } }
JSON
cat > "$RUN/env.sh" <<ENV
export PATH="$PATH" HOME="$RUN/home" COPILOT_HOME="$RUN/copilot-home" TMPDIR="$RUN/tmp" LANG=en_US.UTF-8 TERM=xterm-256color COPILOT_PROVIDER_BASE_URL="http://127.0.0.1:$PORT/v1" COPILOT_PROVIDER_TYPE=openai COPILOT_PROVIDER_WIRE_API=responses COPILOT_MODEL=probe-model COPILOT_OFFLINE=true COPILOT_AUTO_UPDATE=false
ENV
echo "$RUN"
