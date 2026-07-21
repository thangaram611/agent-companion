#!/bin/bash
# drain-completions.sh — surface this Claude Code session's agent-job completions
# into its own context.
#
# Fires on PostToolUse (any tool), UserPromptSubmit, and SessionStart — the
# manifests set no SessionStart matcher, so that means every source (startup,
# resume, clear, compact), not startup alone. Each
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

# Every runtime dir must be 0700 and every runtime file 0600. Setting the umask
# once achieves that for everything created below, and replaces two `chmod`
# spawns that ran unconditionally on every single fire. Do NOT drop this: plain
# `mkdir -p` under a default umask yields 0755, exposing the queue and the
# heartbeat names to other local users.
umask 077

HOST_NAME="${AGENT_COMPANION_HOST:-claude}"
RUNTIME_DIR="${AGENT_RUNTIME_DIR:-$HOME/.$HOST_NAME/agent-companion/runtime}"

QUEUE="${AGENT_QUEUE_PATH:-$RUNTIME_DIR/completions.jsonl}"
LOCK="${QUEUE}.lock"
HEARTBEAT_DIR="${AGENT_HEARTBEAT_DIR:-$RUNTIME_DIR/heartbeats}"

# ---------------------------------------------------------------------------
# Fork budget
#
# This hook fires on PostToolUse with matcher ".*" — i.e. after EVERY tool call
# — and the queue is empty on well over 99% of those fires. On a machine with
# an endpoint-security system extension, each fork+exec costs ~12-17ms, so the
# original empty-queue path (mkdir, chmod, cat, command -v, two jq pipelines,
# mkdir, chmod, touch ≈ 13 processes) cost ~113ms per tool call.
#
# Everything below is arranged so the empty-queue path spawns NOTHING. Reaching
# for jq, or for any external binary, is deferred until there is actual work.
# ---------------------------------------------------------------------------

# Slurp stdin with a builtin, no fork — the fork budget above is the whole
# point of this arrangement.
#
# NOT `$(</dev/stdin)`. That reopens stdin by path, and on Linux /dev/stdin is a
# symlink to /proc/self/fd/0, which for an ANONYMOUS PIPE resolves to a
# `pipe:[N]` entry that cannot be opened: the hook dies with
# "/dev/stdin: No such device or address". Hosts feed hook payloads over exactly
# such a pipe, so that form works on macOS (where /dev/stdin dups fd 0) and is
# dead on every Linux install. `read` uses the already-open fd 0 instead and
# never reopens anything, so it is correct on both.
#
# `-d ''` reads to EOF rather than to a newline, so the buffer is complete —
# a truncated one would reach jq as invalid JSON and abort the hook under
# `set -e`. `IFS=` keeps leading whitespace, `-r` keeps backslashes, and the
# `|| true` absorbs the non-zero status `read` returns when it stops at EOF
# instead of finding the delimiter. Verified on a piped 200KB payload.
IFS= read -r -d '' PAYLOAD || true

# Resolve jq lazily and without a subshell where possible. `command -v` runs in
# a command substitution (a fork), so probe the standard locations with builtin
# tests first and fall back only if none match.
JQ_BIN=""
resolve_jq() {
  [ -n "$JQ_BIN" ] && return 0
  if [ -n "${AGENT_COMPANION_JQ:-}" ] && [ -x "$AGENT_COMPANION_JQ" ]; then
    JQ_BIN="$AGENT_COMPANION_JQ"; return 0
  fi
  for _c in /usr/bin/jq /opt/homebrew/bin/jq /usr/local/bin/jq; do
    if [ -x "$_c" ]; then JQ_BIN="$_c"; return 0; fi
  done
  JQ_BIN="$(command -v jq 2>/dev/null || true)"
  [ -n "$JQ_BIN" ]
}

# Session id, cheaply — but only from a shape where "cheap" cannot be wrong.
#
# The match is anchored to the FIRST key of the top-level object. That anchor is
# load-bearing: an unanchored search would also match a nested "session_id",
# and this very repo emits one — bridge-server/server.mjs declares session_id in
# AGENT_OUTPUT_SCHEMA, so an agent-bridge tool_response carries the key inside
# the payload. `([^"]+)` (not a character whitelist) means a session id
# containing any character still matches rather than silently yielding empty,
# which would disable delivery AND the heartbeat with a clean exit 0.
#
# Any other payload shape — reordered keys, whitespace, a host that puts
# session_id later — falls through to the jq parse below. That costs a fork,
# exactly as before; it never produces a wrong answer.
MY_SID=""
if [[ $PAYLOAD =~ ^\{[[:space:]]*\"session_id\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
  MY_SID="${BASH_REMATCH[1]}"
fi
if [ -z "$MY_SID" ]; then
  if ! resolve_jq; then
    echo "agent-companion: jq not found; cannot drain completion queue" >&2
    exit 0
  fi
  MY_SID=$(printf '%s' "$PAYLOAD" | "$JQ_BIN" -r '.session_id // empty')
fi

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
#
# Cost note: this block must stay above the queue-empty fast path, so it has to
# be free. The `[ -d ]` guard and the `: >` redirect are builtins, so a warm
# runtime dir spawns nothing; the mkdir survives (rather than being deleted on
# the assumption the bridge creates the dir) because on a machine where the
# bridge has never run, heartbeats/ does not exist and the session would never
# register as live. `: >` replaces `touch`: same result for the only consumer,
# which reads mtime and expects a zero-byte file.
[ -d "$HEARTBEAT_DIR" ] || mkdir -p "$HEARTBEAT_DIR" 2>/dev/null || true
# Sanitized for use as a filename — mirrors lib/host.mjs:sanitizeHostSessionId.
# The raw id is kept in MY_SID for jq's --arg; only the filename is folded.
HB_SID="${MY_SID//[^a-zA-Z0-9._-]/_}"
{ : > "$HEARTBEAT_DIR/$HB_SID.heartbeat"; } 2>/dev/null || true

# Fast path: nothing queued AND no stranded snapshot → no-op silently. Outside
# the lock because the worst case is racing into the locked path and finding
# nothing. Everything above this line is builtins, so this is where the hook
# returns on the overwhelming majority of fires, having spawned no processes.
#
# The orphan glob has to be part of THIS test rather than living after the
# lock: the failure that strands a snapshot is a drain killed after its
# move-aside, which leaves no queue file at all. A bare `-s "$QUEUE"` would
# return here and the recovery below would be unreachable in precisely the case
# it exists for. Glob expansion is a shell builtin — one readdir, no process —
# so the zero-fork property is preserved.
if [ ! -s "$QUEUE" ]; then
  _stranded=0
  for _o in "$QUEUE".drain.*; do
    if [ -f "$_o" ]; then _stranded=1; break; fi
  done
  [ "$_stranded" = "1" ] || exit 0
fi

# From here on there is real work, so jq is mandatory. Resolving it here rather
# than at the top means a machine without jq stays silent while idle and only
# warns when a completion actually needed delivering.
if ! resolve_jq; then
  echo "agent-companion: jq not found; cannot drain completion queue" >&2
  exit 0
fi

# Acquire the per-queue lock. mkdir is atomic and POSIX-portable (flock isn't
# installed on macOS by default). Five 100ms attempts; if still contended,
# skip this drain — the next hook event will retry.
#
# The holder's pid is recorded so a lock can be reclaimed when its owner died
# without running its EXIT trap. hooks.json gives this hook a 5s timeout, so
# being killed mid-drain is a real scenario, and without reclaim a single such
# kill would leave the lock directory behind and wedge the queue permanently
# for every later session — mkdir would fail forever and every drain would
# silently exit 0.
DRAIN=""
acquired=0
for _ in 1 2 3 4 5; do
  if mkdir "$LOCK" 2>/dev/null; then acquired=1; break; fi
  _holder=""
  [ -f "$LOCK/pid" ] && read -r _holder < "$LOCK/pid" 2>/dev/null || true
  if [ -n "$_holder" ] && ! kill -0 "$_holder" 2>/dev/null; then
    rm -rf "$LOCK" 2>/dev/null || true
    if mkdir "$LOCK" 2>/dev/null; then acquired=1; break; fi
  fi
  sleep 0.1
done
[ "$acquired" = "1" ] || exit 0
echo $$ > "$LOCK/pid" 2>/dev/null || true

# Release the lock and, critically, put the snapshot back if we die still
# holding it. The move-aside below renames the queue out of the way; anything
# that exits between that rename and the kept-rows write would otherwise leave
# every row in a `.drain.<pid>` file that no code path ever reads again.
# Trapping TERM/INT explicitly is what makes the EXIT trap run on a timeout
# kill rather than being bypassed.
_release() {
  if [ -n "$DRAIN" ] && [ -f "$DRAIN" ]; then
    cat "$DRAIN" >> "$QUEUE" 2>/dev/null || true
    rm -f "$DRAIN" 2>/dev/null || true
  fi
  rm -rf "$LOCK" 2>/dev/null || true
}
trap _release EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

# Adopt snapshots stranded by an earlier drain that died before it could
# restore its own (a SIGKILL, which no trap can catch). Holding the lock means
# no other drain can currently be between its move-aside and its cleanup, so
# any `.drain.*` sitting here is by definition an orphan. This runs before the
# emptiness re-check so orphans are recovered even when the live queue is gone.
for _orphan in "$QUEUE".drain.*; do
  [ -f "$_orphan" ] || continue
  cat "$_orphan" >> "$QUEUE" 2>/dev/null || true
  rm -f "$_orphan" 2>/dev/null || true
done

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
PARTITIONS=$("$JQ_BIN" -Rrn \
  --arg sid "$MY_SID" \
  --argjson alertCutoff "$ALERT_CUTOFF" \
  --argjson terminalCutoff "$TERMINAL_CUTOFF" '
  def fresh:
    (.kind // "") as $k |
    if $k == "alert" then .ts > $alertCutoff
    else .ts > $terminalCutoff end;

  def tagged: (.claudeSessionId // null) != null;

  # -Rn + `inputs | fromjson?` parses line by line and DROPS anything that is
  # not valid JSON. Under -s a single corrupt byte anywhere in the file aborts
  # jq, and because that happens after the move-aside it used to strand every
  # row in the snapshot — one bad line permanently killed the whole queue. A
  # line that cannot be parsed can never be delivered to anyone anyway, so
  # dropping it is both safe and self-healing.
  [inputs | fromjson?] |
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

# Derived here, not at the top: it has exactly one reader (the emit below), so
# computing it earlier was a jq pipeline of pure dead work on every fire that
# delivered nothing — which is nearly all of them.
HOOK_EVENT=$(printf '%s' "$PAYLOAD" | "$JQ_BIN" -r '.hook_event_name // "PostToolUse"')

"$JQ_BIN" -n --arg ctx "$CONTENT" --arg evt "$HOOK_EVENT" '{
  hookSpecificOutput: {
    hookEventName: $evt,
    additionalContext: $ctx
  }
}'
exit 0
