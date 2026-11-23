#!/bin/bash
set -e
umask 077
here="${BASH_SOURCE[0]%/*}"
. "$here/host-paths.sh"
runtime="${AGENT_RUNTIME_DIR:-}"
if [[ -z $runtime ]]; then
  host_paths "${AGENT_COMPANION_HOST:-claude}" "${here%/*}"
  runtime="$HOST_STATE_DIR/runtime"
fi

tmp_root="${TMPDIR:-/tmp}"
if [[ -n ${NODE_TEST_CONTEXT:-} && $runtime != $tmp_root && $runtime != "${tmp_root%/}/"* ]]; then
  real_home="$(eval echo "~$(/usr/bin/id -un)")"
  if [[ $runtime == "$real_home" || $runtime == "$real_home/"* ]]; then
    echo "agent-companion: refusing to use the operator's real runtime dir ($runtime) from inside node --test" >&2
    exit 78
  fi
fi

# Hosts use anonymous pipes. Read the open fd, never reopen /dev/stdin.
IFS= read -r -d '' PAYLOAD || true
literal_session() {
  local LC_ALL=C
  [[ $1 != . && $1 != .. && $1 != '~'* && $1 != */* && $1 != *'\'* && ${#1} -le 255 ]]
}
if [[ $1 == post-tool || $1 == prompt ]]; then
  if [[ $PAYLOAD =~ ^\{[[:space:]]*\"session_id\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
    session="${BASH_REMATCH[1]}"
    if literal_session "$session" && [[ ! -e "$runtime/news/$session" ]]; then
      exit 0
    fi
  fi
fi

if . "$here/node-tools.sh" && node_bin="$(resolve_node)" && "$node_bin" "$here/hook.mjs" "$1" <<< "$PAYLOAD"; then exit 0; fi
if [[ $1 == pre-tool ]]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"LEAD_REQUIRED: the lead identity hook could not run"}}'
else
  exit 1
fi
