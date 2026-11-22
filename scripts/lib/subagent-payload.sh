#!/usr/bin/env bash
is_subagent_payload() {
  local id
  id="$(printf '%s' "$1" | jq -r '.agent_id // "" | tostring' 2>/dev/null)" || return 1
  [[ -n "$id" ]]
}
