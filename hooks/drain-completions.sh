#!/bin/bash
# drain-completions.sh — surface this Claude Code session's agent-job completions
# into its own context.
#
# Fires on PostToolUse (any tool), UserPromptSubmit, SessionStart:startup. Each
# bridge writes events tagged with its Claude Code session id; this drain only
# delivers and only retains rows whose tag matches the firing session, dropping
# stale and untagged rows by TTL. Move-aside pattern (rename queue → process
# snapshot → append kept rows back) ensures concurrent bridge appends during
# the drain are not overwritten — they land in the freshly-created queue file
# whose contents the drain never touches. mkdir-lock serializes concurrent
# drains so two `mv` operations cannot race for the same snapshot.
#
# Empty queue or missing session id → no injection, no context pollution.

set -e
HOST_NAME="${AGENT_COMPANION_HOST:-claude}"
RUNTIME_DIR="${AGENT_RUNTIME_DIR:-$HOME/.$HOST_NAME/agent-companion/runtime}"
mkdir -p "$RUNTIME_DIR" 2>/dev/null || true
chmod 700 "$RUNTIME_DIR" 2>/dev/null || true

QUEUE="${AGENT_QUEUE_PATH:-$RUNTIME_DIR/completions.jsonl}"
LOCK="${QUEUE}.lock"
HEARTBEAT_DIR="${AGENT_HEARTBEAT_DIR:-$RUNTIME_DIR/heartbeats}"

PAYLOAD=$(cat)
if [ -n "${AGENT_COMPANION_JQ:-}" ] && [ -x "$AGENT_COMPANION_JQ" ]; then
  JQ_BIN="$AGENT_COMPANION_JQ"
else
  JQ_BIN="$(command -v jq 2>/dev/null || true)"
fi
if [ -z "$JQ_BIN" ]; then
  echo "agent-companion: jq not found; cannot drain completion queue" >&2
  exit 0
fi
HOOK_EVENT=$(printf '%s' "$PAYLOAD" | "$JQ_BIN" -r '.hook_event_name // "PostToolUse"')
MY_SID=$(printf '%s' "$PAYLOAD" | "$JQ_BIN" -r '.session_id // empty')

# Without a session id we cannot tell which rows belong to us — refuse to
# inject anything. Hook payloads from real Claude Code sessions always carry
# session_id, so this only triggers on misconfigured callers.
[ -n "$MY_SID" ] || exit 0

# Heartbeat: the daemon's heartbeat-aware inactivity tick scans this dir for
# fresh mtimes and reschedules its shutdown timer when any host is still
# active. Touch BEFORE the queue-empty fast path so idle drains (the common
# case between Copilot jobs) still count as liveness — without this the
# 15-min daemon idle timer would terminate the Copilot subprocess mid-session
# whenever the user goes a stretch without triggering a Copilot job, even if
# they're actively using Claude Code. Best-effort; failure here must not
# block the drain.
mkdir -p "$HEARTBEAT_DIR" 2>/dev/null || true
chmod 700 "$HEARTBEAT_DIR" 2>/dev/null || true
touch "$HEARTBEAT_DIR/$MY_SID.heartbeat" 2>/dev/null || true

# Fast path: no queue file, or empty file → no-op silently. Outside the lock
# because the worst case is racing into the locked path and finding nothing.
[ -s "$QUEUE" ] || exit 0

# Acquire the per-queue lock. mkdir is atomic and POSIX-portable (flock isn't
# installed on macOS by default). Five 100ms attempts; if still contended,
# skip this drain — the next hook event will retry.
acquired=0
for _ in 1 2 3 4 5; do
  if mkdir "$LOCK" 2>/dev/null; then acquired=1; break; fi
  sleep 0.1
done
[ "$acquired" = "1" ] || exit 0
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

# Re-check after lock acquisition: the prior holder may have just emptied it.
[ -s "$QUEUE" ] || exit 0

# Move-aside: rename the queue to a side file we own exclusively, then process
# the snapshot. Concurrent bridge writers (appendFileSync into $QUEUE) recreate
# the queue file at the original path on their next append; those rows are
# never touched by this drain. Without this rename, an append landing between
# the partition jq read and the kept-rows write would be silently overwritten.
DRAIN="${QUEUE}.drain.$$"
mv "$QUEUE" "$DRAIN" 2>/dev/null || exit 0
[ -s "$DRAIN" ] || { rm -f "$DRAIN"; exit 0; }

# Test-only race-reproduction hook. With DEBUG_DRAIN_DELAY=N (seconds) set,
# pause between rename and partition. Production callers never set this env
# var, so the sleep is a no-op. Used by the late-append regression test to
# inject a row into the recreated $QUEUE while the drain is mid-flight.
[ -n "${DEBUG_DRAIN_DELAY:-}" ] && sleep "$DEBUG_DRAIN_DELAY"

NOW_MS=$(($(date +%s) * 1000))
ALERT_TTL_MS=$((5 * 60 * 1000))      # tier-1 watchdog alerts: 5 min relevance window
TERMINAL_TTL_MS=$((30 * 60 * 1000))  # terminal events: 30 min retention before drop

ALERT_CUTOFF=$((NOW_MS - ALERT_TTL_MS))
TERMINAL_CUTOFF=$((NOW_MS - TERMINAL_TTL_MS))

# Three partitions in one jq pass over the snapshot's array form:
#   .deliver — rows belonging to this session, fresh, unconsumed → injected
#   .keep    — rows belonging to other sessions, fresh, unconsumed → retained
#   (everything else dropped: untagged, own-already-consumed, any-stale-past-TTL)
PARTITIONS=$("$JQ_BIN" -rs \
  --arg sid "$MY_SID" \
  --argjson alertCutoff "$ALERT_CUTOFF" \
  --argjson terminalCutoff "$TERMINAL_CUTOFF" '
  def fresh:
    (.kind // "") as $k |
    if $k == "alert" then .ts > $alertCutoff
    else .ts > $terminalCutoff end;

  def tagged: (.claudeSessionId // null) != null;

  {
    deliver: map(select(tagged and .claudeSessionId == $sid and .consumed != true and fresh)),
    keep:    map(select(tagged and .claudeSessionId != $sid and .consumed != true and fresh)),
  }
' < "$DRAIN")

# Append kept rows back to $QUEUE (which may have been recreated by concurrent
# appenders since the rename). printf >> uses O_APPEND; per-line writes for
# JSONL rows in this codebase (terminal envelopes ~1-5 KB) are atomic on POSIX
# below PIPE_BUF=4096 — well within margin in practice.
KEEP_LINES=$(printf '%s' "$PARTITIONS" | "$JQ_BIN" -r '.keep[] | @json')
if [ -n "$KEEP_LINES" ]; then
  printf '%s\n' "$KEEP_LINES" >> "$QUEUE"
fi

rm -f "$DRAIN"

# Build the injection content from the deliver partition (snapshot-derived).
CONTENT=$(printf '%s' "$PARTITIONS" | "$JQ_BIN" -r '
  .deliver |
  map(
    "## \(.meta.target // "agent") `\(.jobId // "?")` — **\(.meta.status // .kind // "unknown")**\n\n" +
    (.content // "")
  ) | join("\n\n---\n\n")
')

if [ -z "$CONTENT" ]; then exit 0; fi

"$JQ_BIN" -n --arg ctx "$CONTENT" --arg evt "$HOOK_EVENT" '{
  hookSpecificOutput: {
    hookEventName: $evt,
    additionalContext: $ctx
  }
}'
exit 0
