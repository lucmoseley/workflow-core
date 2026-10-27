#!/usr/bin/env bash
# push-review-owed.sh — whether the code a push carries owes a review no valid
# marker covers (#1163): guard-push-rules.js's review adapter (#2785).
#
#   push-review-owed.sh <session id> [<tree>]
#
# The test is the Stop backstop's own, lib/code-signal.sh's review_uncovered,
# read over HEAD of <tree> (the repo root where it is empty) rather than the
# working tree, because only committed code is pushed. It stays bash, beside
# concision-backstop.sh.
#
# OUTPUT: nothing where no review is owed, or seven NUL-terminated fields —
# the tier owed (`standard` or `escalated`), the files named, the session's
# start point, the sentence naming the tier, the sentence naming the marker
# lines an escalated change adds, why an existing marker was rejected (empty
# where none was), and the marker writer's path as a session should spell it.
#
# SILENT, exit 0, on every fault — no recorded start point, an unavailable
# ledger, a library that will not load — for the backstop's reason: the Stop
# nag still fires, so silence here costs only the earlier ask. The faults that
# are this adapter's own are logged for check-guard-errors.js.

set -uo pipefail

here="$(dirname "${BASH_SOURCE[0]}")"
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
# Non-zero is ATTRIBUTION UNAVAILABLE, logged by the arbiter (mantahostels#135).
# --committed bills the session's own commits too, the backstop's reason (#2390).
node "$here/session-arbiter.js" writes "$sid" --committed >"$mine" 2>/dev/null || exit 0
[[ -s "$mine" ]] || exit 0
code_signal_floor "$sid"
# shellcheck disable=SC2154  # cs_threshold is code_signal_floor's
review_uncovered "$markers_dir/.codereview-pass-$sid" "$base" "$mine" "$cs_threshold" "$sid" HEAD || exit 0
# shellcheck disable=SC2154  # code-signal.sh's, set by review_uncovered
printf '%s\0' "$cs_tier" "${cs_files% }" "$base" "$cs_tier_line" "$cs_marker_more" \
  "$cs_pass_fault" "$(script_path write-review-marker.js)"
