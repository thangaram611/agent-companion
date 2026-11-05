#!/bin/bash
# Advisory controller evidence: stops/<owner>.json contains
# {owner, source: 'TaskStop'|'SubagentStop', t: epoch milliseconds, session_id}.
# TaskStop names the child in tool_input.task_id; both hosts' SubagentStop use
# agent_id. Missing child identity never falls back to the parent session id.

ROOT="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}"
TOOLS="$ROOT/hooks/node-tools.sh"
if [ -r "$TOOLS" ]; then
  # shellcheck source=/dev/null
  . "$TOOLS"
fi
NODE_BIN="$(resolve_node 2>/dev/null || true)"
[ -n "$NODE_BIN" ] || { echo "agent-companion: node not found; stop marker unavailable" >&2; exit 0; }

"$NODE_BIN" --input-type=module -e '
import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
try {
  const payload = JSON.parse(readFileSync(0, "utf8"));
  const source = payload.hook_event_name === "SubagentStop" ? "SubagentStop"
    : payload.hook_event_name === "PreToolUse" && payload.tool_name === "TaskStop" ? "TaskStop" : null;
  if (!source) process.exit(0);
  const owner = source === "TaskStop" ? payload.tool_input?.task_id : payload.agent_id;
  if (typeof owner !== "string" || !/^[a-zA-Z0-9_-]+$/.test(owner)) {
    console.error(`agent-companion: ${source} lacks a native child id; no stop marker written`);
    process.exit(0);
  }
  const { companionHomeDir, refuseRealHomeUnderTest } = await import(pathToFileURL(join(process.argv[1], "lib/host.mjs")));
  const base = refuseRealHomeUnderTest(process.env.AGENT_COMPANION_HOME || companionHomeDir(), "state dir");
  const dir = join(base, "stops");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${owner}.json`);
  const temp = `${file}.${randomUUID()}.tmp`;
  const marker = { owner, source, t: Date.now(), session_id: typeof payload.session_id === "string" ? payload.session_id : null };
  try {
    writeFileSync(temp, JSON.stringify(marker) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temp, file);
  } finally { rmSync(temp, { force: true }); }
} catch (err) {
  console.error(`agent-companion: stop marker unavailable: ${err.message}`);
}
' "$ROOT"
