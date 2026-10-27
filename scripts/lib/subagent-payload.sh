#!/usr/bin/env bash
# subagent-payload.sh — whether a hook payload came from a subagent. The shell
# face of lib/subagent-payload.js: an `agent_id` is read here, and the
# `SessionStart:compact` freshness stopgap is asked of the JS, so the two
# routes cannot drift apart on its thresholds (#1785, #1837).

_spl_here="${BASH_SOURCE[0]%/*}"
[[ "$_spl_here" == "${BASH_SOURCE[0]}" ]] && _spl_here=.
_SUBAGENT_PAYLOAD_JS="$_spl_here/subagent-payload.js"
unset _spl_here

# is_subagent_payload <payload> — status 0 for a subagent's payload. A payload
# jq cannot read, or no jq, reads as the parent's; so does a compaction where
# node is missing (#1837).
is_subagent_payload() {
  local fields id event source
  fields="$(printf '%s' "$1" | jq -r '[.agent_id // "", .hook_event_name // "",
    .source // ""] | map(tostring) | join("\u001f")' 2>/dev/null)" || return 1
  IFS=$'\x1f' read -r id event source <<<"$fields"
  is_subagent_fields "$id" "$event" "$source" "$1"
}

# is_subagent_fields <agent_id> <hook_event_name> <source> <payload> — the same
# answer, for a caller that has already read the three fields off the payload;
# the payload itself is read only on a compaction.
is_subagent_fields() {
  [[ -n "$1" ]] && return 0
  [[ "$2" == SessionStart && "$3" == compact ]] || return 1
  command -v node >/dev/null 2>&1 || return 1
  node -e 'process.exit(require(process.argv[1]).isSubagentPayload(JSON.parse(process.argv[2])) ? 0 : 1)' \
    "$_SUBAGENT_PAYLOAD_JS" "$4" 2>/dev/null
}
