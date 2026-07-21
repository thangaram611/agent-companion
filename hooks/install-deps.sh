#!/bin/bash
# install-deps.sh — SessionStart hook
#
# Ensures bridge-server's node_modules is installed and reachable from the
# plugin root's bridge-server/. Idempotent, concurrent-safe (flock),
# lockfile-aware (sha256 of package.json + package-lock.json).
#
# NODE_PATH does NOT work for ESM bare imports (Node >= 22 — verified
# empirically). We install to plugin data when the host provides it for update
# persistence and symlink it into the plugin root's bridge-server/ so
# ESM's ancestor-directory resolver finds the deps.
#
# Exits silently on the fast path. Emits a one-line summary on install; writes
# full npm output to install.log.

ROOT="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}"
[ -n "$ROOT" ] || exit 0

TOOLS="$ROOT/hooks/node-tools.sh"
if [ -r "$TOOLS" ]; then
  # shellcheck source=/dev/null
  . "$TOOLS"
fi
NODE_BIN="$(resolve_node 2>/dev/null || true)"
if [ -n "$NODE_BIN" ]; then
  export PATH="$(dirname "$NODE_BIN"):${PATH:-}"
fi
NPM_BIN="$(resolve_npm 2>/dev/null || true)"
if [ -z "$NPM_BIN" ]; then
  echo "agent-companion: npm not found; cannot install bridge dependencies" >&2
  exit 1
fi

# CLAUDE_PLUGIN_DATA/PLUGIN_DATA is only populated for marketplace-installed plugins.
# For --plugin-dir local-dev runs, fall back to a sibling dir under the
# plugin root (not pretty, but keeps local-dev functional).
DATA="${CLAUDE_PLUGIN_DATA:-${PLUGIN_DATA:-$ROOT/.plugin-data}}"

BUNDLED_PKG="$ROOT/bridge-server/package.json"
BUNDLED_LOCK="$ROOT/bridge-server/package-lock.json"
PERSIST_DIR="$DATA/bridge-server"
MANIFEST_HASH="$PERSIST_DIR/.manifest.sha256"
SYMLINK="$ROOT/bridge-server/node_modules"
LOG="$PERSIST_DIR/install.log"

[ -f "$BUNDLED_PKG" ] || exit 0

mkdir -p "$PERSIST_DIR"

# Concurrent-install guard. Two sessions starting within seconds of each
# other would otherwise race `npm install` against the same target and
# corrupt node_modules. Portable mutex via atomic `mkdir` (macOS lacks
# `flock` by default). If the lock is stale (holder PID dead) it reclaims.
#
# The wait budget MUST stay below this hook's timeout in hooks/hooks.json.
# It used to be 60s against a 55s timeout, which meant the host killed the
# hook while it was still sleeping and the clean bail-out below was dead
# code: a contended install ended as a hard hook kill instead of a silent
# "someone else has it". hooks/install-deps.test.mjs pins the invariant.
HOOK_TIMEOUT_SEC=55
LOCK_WAIT_SEC=45
# Test seam. hooks/install-deps.test.mjs proves the contended path bails out
# cleanly, which otherwise costs the full budget in wall-clock per assertion.
# Validated and capped: a malformed value must not produce `[: abc: integer
# expression expected` in the user's session banner, and an oversized one must
# not reinstate the very overrun this budget exists to prevent.
case "${AGENT_COMPANION_LOCK_WAIT_SEC:-}" in
  '' | *[!0-9]*) ;;
  *)
    if [ "$AGENT_COMPANION_LOCK_WAIT_SEC" -gt 0 ] \
        && [ "$AGENT_COMPANION_LOCK_WAIT_SEC" -lt "$HOOK_TIMEOUT_SEC" ]; then
      LOCK_WAIT_SEC="$AGENT_COMPANION_LOCK_WAIT_SEC"
    fi
    ;;
esac

# Ages, in minutes, at which an unreleased lock is presumed abandoned. See
# lock_is_stale.
LOCK_ORPHAN_MIN=1
LOCK_ABANDON_MIN=60

LOCK_DIR="$PERSIST_DIR/.install.lock.d"

# Only drop the lock if we are still the recorded holder. Once npm starts, the
# pid file names the npm process, not this shell — see the install step below
# for why. Releasing then would hand the next session a green light while npm
# is still writing node_modules, which is exactly the corruption the lock
# exists to prevent.
release_lock() {
  if [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" = "$$" ]; then
    rm -rf "$LOCK_DIR"
  fi
}

# Is the lock abandoned? Three cases, most confident first:
#   1. a holder is recorded but that process is gone   → stale, reclaim now.
#   2. no holder was ever recorded                     → the previous shell died
#      in the microsecond window between `mkdir` and the pid write. Without this
#      case that lock is immortal: every future session waits out its budget and
#      exits 0, node_modules is never installed, the bridge never starts, and
#      every hook still reports success. Silent, permanent breakage.
#   3. the lock is absurdly old                        → backstop for pid reuse,
#      where `kill -0` is answering about an unrelated process. The threshold is
#      far beyond any real `npm ci`.
#
# Cases 2 and 3 compare the lock dir's own age against now, via `find -mmin`
# (portable across BSD and GNU find). That is safe here and is NOT the
# mtime-freshness trap that rules out timestamp checks elsewhere in this plugin:
# this directory is created locally by `mkdir` and never arrives via tar /
# `cp -p` / `rsync -a`, so no preserved older timestamp can reach it.
older_than_min() {
  [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +"$1" 2>/dev/null)" ]
}

lock_is_stale() {
  local holder
  holder="$(cat "$LOCK_DIR/pid" 2>/dev/null)"
  if [ -n "$holder" ]; then
    kill -0 "$holder" 2>/dev/null || return 0
    older_than_min "$LOCK_ABANDON_MIN"
    return $?
  fi
  older_than_min "$LOCK_ORPHAN_MIN"
}

WAIT="$LOCK_WAIT_SEC"
while [ "$WAIT" -gt 0 ]; do
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "$$" > "$LOCK_DIR/pid"
    trap 'release_lock' EXIT
    trap 'release_lock; exit 143' INT TERM HUP
    break
  fi
  if lock_is_stale; then
    rm -rf "$LOCK_DIR"
    continue
  fi
  sleep 1
  WAIT=$((WAIT - 1))
done
if [ ! -d "$LOCK_DIR" ] || [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" != "$$" ]; then
  # Couldn't acquire in time — another SessionStart holds it; it'll finish
  # the install on our behalf. Exit cleanly so the hook banner stays green.
  exit 0
fi

hash_files() {
  if command -v sha256sum >/dev/null 2>&1; then
    cat "$@" 2>/dev/null | sha256sum | cut -d' ' -f1
  else
    cat "$@" 2>/dev/null | shasum -a 256 | cut -d' ' -f1
  fi
}

# Hash covers both package.json and package-lock.json so transitive-only
# lockfile changes (npm audit fix, peer bumps) trigger reinstall.
if [ -f "$BUNDLED_LOCK" ]; then
  EXPECT_HASH=$(hash_files "$BUNDLED_PKG" "$BUNDLED_LOCK")
else
  EXPECT_HASH=$(hash_files "$BUNDLED_PKG")
fi

STORED_HASH=""
[ -f "$MANIFEST_HASH" ] && STORED_HASH=$(tr -d '[:space:]' < "$MANIFEST_HASH")

# Does ROOT's bridge-server/node_modules actually reach the managed install?
#
# `-ef` is a bash test builtin that compares device+inode AFTER following
# symlinks. The old check was `[ -L "$SYMLINK" ]`, which only asked "is
# something symlink-shaped here". A dangling link, a link aimed at an unrelated
# node_modules, a link to an empty directory, a broken chain, a self-referential
# loop, and a link to a regular file all passed it while ESM's bare-import
# resolution was dead — and because the fast path then exited 0, every later
# session skipped over the wreckage too. Silent, permanent breakage with no
# repair path. `-ef` is false for every one of those and true for the three
# shapes that genuinely work (direct link, link chain, relative link). It is
# also right across macOS's /tmp -> /private/tmp aliasing, where comparing
# `readlink` output as a string is wrong in the other direction, and it needs no
# `readlink -f` / `realpath` (absent on older BSD userland).
link_ok() {
  [ -d "$PERSIST_DIR/node_modules" ] && [ "$SYMLINK" -ef "$PERSIST_DIR/node_modules" ]
}

# Two independent questions, asked separately.
#   "are the managed deps installed and manifest-current?"  → repaired by npm
#   "does the plugin root's node_modules reach them?"       → repaired by one ln
# Conjoining them meant a purely cosmetic link fault cost a full reinstall, and
# the commonest cause of one is entirely routine: a plugin upgrade moves ROOT,
# or the host relocates plugin data, while PERSIST_DIR's install stays perfectly
# valid.
DEPS_OK=0
if [ -d "$PERSIST_DIR/node_modules" ] && [ "$EXPECT_HASH" = "$STORED_HASH" ]; then
  DEPS_OK=1
fi

# Fast path: deps current AND the link genuinely resolves to them. Silent, no
# npm, no writes — this runs on every SessionStart of every session.
if [ "$DEPS_OK" = 1 ] && link_ok; then
  exit 0
fi

if [ "$DEPS_OK" = 0 ]; then
  # Copy the manifest into DATA so `npm ci` / `npm install` can run there. The
  # -ef guards cover a DATA == ROOT layout, where source and destination are the
  # same file and `cp` writes "... are identical (not copied)" straight into the
  # user's session banner.
  [ "$BUNDLED_PKG" -ef "$PERSIST_DIR/package.json" ] \
    || cp "$BUNDLED_PKG" "$PERSIST_DIR/package.json"
  if [ -f "$BUNDLED_LOCK" ] && ! [ "$BUNDLED_LOCK" -ef "$PERSIST_DIR/package-lock.json" ]; then
    cp "$BUNDLED_LOCK" "$PERSIST_DIR/package-lock.json"
  fi

  # Prefer `npm ci` when a lockfile is present: it wipes node_modules first, so
  # a killed prior install (SessionStart timeout) can't leave corrupt state.
  if [ -f "$PERSIST_DIR/package-lock.json" ]; then
    INSTALL_ARGS=(ci --silent --no-audit --no-fund)
  else
    INSTALL_ARGS=(install --silent --no-audit --no-fund)
  fi

  cd "$PERSIST_DIR" || { echo "agent-companion: cd $PERSIST_DIR failed" >&2; exit 1; }

  # Run npm in the background and hand the lock to IT, not to this shell. The
  # process that owns node_modules is npm, and it outlives us: this hook has a
  # hard timeout, and when the host kills it npm is orphaned and keeps
  # installing. With the shell's pid in the lock, that kill made the lock
  # instantly look stale and the next session started a second `npm ci` on top
  # of a live one. With npm's pid there, the lock stays held for exactly as long
  # as the install runs, and goes stale the moment it doesn't.
  "$NPM_BIN" "${INSTALL_ARGS[@]}" >"$LOG" 2>&1 &
  NPM_PID=$!
  echo "$NPM_PID" > "$LOCK_DIR/pid"
  wait "$NPM_PID"
  NPM_STATUS=$?
  # Take the lock back ONLY if npm is still the recorded holder. In the instant
  # between npm exiting and this line the lock names a dead pid, so a waiter can
  # legitimately declare it stale and acquire it. Writing our pid unconditionally
  # would then make our EXIT trap delete a lock that a live holder owns — handing
  # a third session a green light and putting two `npm ci` runs on one target,
  # the exact corruption this lock exists to prevent.
  if [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" = "$NPM_PID" ]; then
    echo "$$" > "$LOCK_DIR/pid"
  fi

  if [ "$NPM_STATUS" -ne 0 ]; then
    rm -f "$MANIFEST_HASH"
    echo "agent-companion: npm install failed (see $LOG)" >&2
    exit 1
  fi

  if [ ! -d "$PERSIST_DIR/node_modules" ]; then
    # npm reported success and produced nothing. Say what actually happened,
    # rather than letting the link step below report a misleading link failure.
    echo "agent-companion: npm reported success but left no $PERSIST_DIR/node_modules (see $LOG)" >&2
    exit 1
  fi

  # Record the hash BEFORE touching the link. The deps in PERSIST_DIR are
  # installed and current whatever happens to ROOT's node_modules slot, and
  # deferring this meant a slot we cannot write — a read-only plugin mount, a
  # root-owned directory — re-ran the entire `npm ci` on every SessionStart
  # forever, inside a 55s budget, for an install that was already complete.
  echo "$EXPECT_HASH" > "$MANIFEST_HASH"
fi

# Point ROOT's bridge-server/node_modules at the managed install so ESM's
# ancestor walk from server.mjs finds the deps. Re-checked every session because
# plugin updates move ROOT and hosts relocate plugin data — but now reachable
# WITHOUT a reinstall.
if ! link_ok; then
  # Nothing here is user data: this slot is the plugin's own, it is gitignored,
  # and whatever occupies it is regenerable node_modules. It may be a stale
  # symlink, or a real directory from setup.sh's in-tree `npm ci` (setup.sh:164)
  # or a developer's own `npm install`. Converging it to the managed link is the
  # intended end state and has been this hook's behaviour since v0.0.1, so we
  # replace it — but only now that the managed install is confirmed present, so
  # there is never a moment with neither.
  #
  # `rm -rf` cannot touch the managed install itself: link_ok is false, so the
  # slot is a different inode, and removing a symlink never follows it. The
  # DATA == ROOT degenerate case, where the slot IS the managed tree, is exactly
  # the case link_ok returns true for — which is why this is guarded by it and
  # not merely by `-L`.
  REPLACED_DIR=0
  [ -d "$SYMLINK" ] && [ ! -L "$SYMLINK" ] && REPLACED_DIR=1
  rm -rf "$SYMLINK" 2>/dev/null
  # `-n` so that if anything raced a symlink-to-directory back into the slot, ln
  # replaces it instead of dereferencing it and creating node_modules/node_modules
  # INSIDE the target — which plain `ln -s` does silently, exiting 0.
  ln -sfn "$PERSIST_DIR/node_modules" "$SYMLINK" 2>/dev/null

  # Verify rather than trust `ln`'s status, which is 0 in several states that
  # still leave the slot unusable. The old code discarded it entirely and then
  # printed "deps ready" over a bridge that could not resolve a single import.
  if ! link_ok; then
    echo "agent-companion: could not link $SYMLINK -> $PERSIST_DIR/node_modules" >&2
    exit 1
  fi
  # Converged, so this cannot repeat — no say-once bookkeeping needed.
  [ "$REPLACED_DIR" = 1 ] && echo "agent-companion: replaced bridge-server/node_modules with a link to $PERSIST_DIR/node_modules"
  [ "$DEPS_OK" = 1 ] && echo "agent-companion: repaired bridge-server/node_modules link"
fi

[ "$DEPS_OK" = 0 ] && echo "agent-companion: deps ready"
exit 0
