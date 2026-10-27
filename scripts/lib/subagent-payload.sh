#!/usr/bin/env bash
# subagent-payload.sh — whether a hook payload came from a subagent. The shell
# face of lib/subagent-payload.js: an `agent_id` is read here, and the
# `SessionStart:compact` freshness stopgap is asked of the JS, so the two
# routes cannot drift apart on its thresholds (workflow-core#1785, workflow-core#1837).

_SUBAGENT_PAYLOAD_JS="$(dirname "${BASH_SOURCE[0]}")/subagent-payload.js"

# is_subagent_payload <payload> — status 0 for a subagent's payload. A payload
# jq cannot read, or no jq, reads as the parent's; so does a compaction where
# node is missing (workflow-core#1837).
is_subagent_payload() {
  local fields id event source
  fields="$(printf '%s' "$1" | jq -r '[.agent_id // "", .hook_event_name // "",
    .source // ""] | map(tostring) | join("\u001f")' 2>/dev/null)" || return 1
  IFS=$'\x1f' read -r id event source <<<"$fields"
  [[ -n "$id" ]] && return 0
  [[ "$event" == SessionStart && "$source" == compact ]] || return 1
  command -v node >/dev/null 2>&1 || return 1
  node -e 'process.exit(require(process.argv[1]).isSubagentPayload(JSON.parse(process.argv[2])) ? 0 : 1)' \
    "$_SUBAGENT_PAYLOAD_JS" "$1" 2>/dev/null
}
