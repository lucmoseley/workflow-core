#!/usr/bin/env bash
set -uo pipefail

dir=${WFC_REFILL_DIR:-}
if [[ -z $dir ]]; then
  [[ ${HOME:-} == /* ]] || exit 0
  dir=$HOME/.claude
fi
[[ -f $dir/.refill-loop.pid ]] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

sid=$(jq -r 'select((.background_tasks // []) + (.session_crons // []) == []
  or ((.last_assistant_message // "") | [splits("\n") | select(test("\\S"))] | last // ""
    | test("^(result|needs input):")))
  | .session_id // empty' 2>/dev/null) || exit 0
[[ -n $sid ]] || exit 0
jq -e --arg s "$sid" \
  'any(.launches[]?; .finishedAt == null and (.sessionId == $s or (.jobId != null and .jobId == $s[0:8])))' \
  "$dir/.refill-loop-state.json" >/dev/null 2>&1 || exit 0
printf '%s %s\n' "$(date +%s%3N)" "$sid" >>"$dir/.refill-loop-wake" 2>/dev/null
exit 0
