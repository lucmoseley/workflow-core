#!/usr/bin/env bash
# refill-wake.sh — the plugin's Stop hook that wakes the refill loop when a
# session it launched ends (workflow-core#2313, spec workflow-core#2245 §Waking): it appends
# `<ms> <session id>` to the wake file beside the loop's pidfile
# (lib/refill-wake.js) where that pidfile exists and the ending session is an
# open launch's. Anything else exits 0 silently, the pidfile test first and
# spawning nothing: this runs at every session's every turn end.
#
# A turn end whose payload lists background work in flight or a scheduled
# wake-up wakes nothing, the session taking another turn, unless its last line
# opens `result:` or `needs input:`, the background job's own end marker: a
# session can end with a forgotten watcher still running (workflow-core#2466). A launched
# session that ends with no waking Stop is left to the fallback poll.
#
# A launch is matched on its sessionId, or before the loop's first listing
# has captured one, on its jobId: `claude --bg`'s job id is the session id's
# first 8 characters (observed; no documented contract).
#
# The loop's directory is WFC_REFILL_DIR, else ~/.claude, as
# lib/refill-loop.js's loopFiles() reads it; a relative HOME wakes nothing,
# as machineMarkerPath refuses one.
#
# IMPLICIT:  appends to the refill loop's wake file when a session it launched ends
# JUSTIFIED: convenience — the loop refills the slot without waiting out its poll
# DEFEAT:    none

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
