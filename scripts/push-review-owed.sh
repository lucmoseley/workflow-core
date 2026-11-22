#!/usr/bin/env bash
set -uo pipefail

here="${BASH_SOURCE[0]%/*}"
[[ "$here" == "${BASH_SOURCE[0]}" ]] && here=.
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null
declare -F gl_log >/dev/null 2>&1 || gl_log() { :; }

sid="${1-}"
tree="${2-}"
[[ -n "$sid" ]] || exit 0

unloaded() {
  gl_log "lib/$1 did not load — push not checked for review"
  exit 0
}
# shellcheck source=scripts/lib/marker-root.sh
source "$here/lib/marker-root.sh" 2>/dev/null || unloaded marker-root.sh
# shellcheck source=scripts/lib/concision-marker.sh
source "$here/lib/concision-marker.sh" 2>/dev/null || unloaded concision-marker.sh
# shellcheck source=scripts/lib/code-signal.sh
source "$here/lib/code-signal.sh" 2>/dev/null || unloaded code-signal.sh
# shellcheck source=scripts/lib/script-path.sh
source "$here/lib/script-path.sh" 2>/dev/null || unloaded script-path.sh

markers_dir="$(gr_markers_dir)"
[[ -n "$markers_dir" ]] || exit 0
cd "${tree:-$(gr_root)}" 2>/dev/null || {
  gl_log "could not enter the pushed tree — push not checked for review"
  exit 0
}
base="$(concision_session_base "$markers_dir" "$sid")" || exit 0
mine="$(mktemp 2>/dev/null)" || {
  gl_log "mktemp failed — push not checked for review"
  exit 0
}
trap 'rm -f "$mine"' EXIT
node "$here/session-arbiter.js" writes "$sid" --committed >"$mine" 2>/dev/null || exit 0
[[ -s "$mine" ]] || exit 0
code_signal_floor "$sid"
review_uncovered "$markers_dir/.codereview-pass-$sid" "$base" "$mine" "$cs_threshold" "$sid" HEAD || exit 0
printf '%s\0' "$cs_tier" "${cs_files% }" "$base" "$cs_tier_line" "$cs_marker_more" \
  "$cs_pass_fault" "$(script_path write-review-marker.js)"
