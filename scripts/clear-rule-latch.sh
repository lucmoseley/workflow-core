#!/usr/bin/env bash
set -uo pipefail

here="${BASH_SOURCE[0]%/*}"
[[ "$here" == "${BASH_SOURCE[0]}" ]] && here=.
here="$(cd "$here" && pwd)"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null
declare -F gl_log >/dev/null 2>&1 || gl_log() { :; }
# shellcheck source=scripts/lib/marker-root.sh
source "$here/lib/marker-root.sh" 2>/dev/null
declare -F gr_markers_dir >/dev/null 2>&1 || gr_markers_dir() { :; }

payload="$(cat)"
[[ -n "$payload" ]] || exit 0
command -v jq >/dev/null 2>&1 || {
  gl_log "jq not found — rule latches left in place across a compaction"
  exit 0
}
sid="$(printf '%s' "$payload" | jq -j '.session_id // ""' 2>/dev/null)" || {
  gl_log "PreCompact payload did not parse — rule latches left in place"
  exit 0
}
[[ -n "$sid" ]] || {
  gl_log "no session_id on the PreCompact payload — rule latches left in place"
  exit 0
}
sid="${sid//[^A-Za-z0-9_-]/_}"

markers="$(gr_markers_dir)"
[[ -n "$markers" ]] || exit 0
shopt -s nullglob
for f in "$markers"/.rule-injected-*-"$sid"; do
  rm -f "$f" 2>/dev/null
done
exit 0
