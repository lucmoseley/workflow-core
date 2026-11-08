#!/usr/bin/env bash
# write-self-plugin-marker.sh — SessionStart hook of the self-plugin alone:
# writes this session's marker, the proof scripts/self-plugin-canary.sh reads
# that the self-plugin loaded (#2438, spec #2295).
#
# Registered with no matcher, so a session whose id changes at a clear or
# compact gets a marker under the new one.
#
# It and the canary run the main checkout's copies (#4701), so a change to the
# marker path reaches every running session at its next call, against markers
# written at their starts. The levelling pass therefore re-marks every live
# session with the target's copy before it moves the main checkout, and does
# not move it while the target's canary would still refuse one
# (lib/canary-remark.js).
#
# The marker path is lib/self-plugin-marker.sh's, under `.claude/tmp/markers/`
# resolved from CLAUDE_PROJECT_DIR, a linked worktree's own where the session
# runs in one. arbiter-markers.js's pruneMarkers sweeps it by age in either.
#
# Never rendered into the adopters' hooks/hooks.json (lib/core-hooks.js's
# MARKER_WRITER): nothing there reads it.
#
# A marker it fails to write is recorded through lib/guard-log.sh; the canary
# then refuses the session's first tool call.
#
# IMPLICIT:  writes an empty `.self-plugin-loaded-<session id>` marker under `.claude/tmp/markers/` at every session start, unasked (#2438).
# JUSTIFIED: fail-safe — the marker is the canary's only proof the self-plugin's guards loaded; without it every session is refused.
# DEFEAT:    none
# TREE:      host — writes this session's self-plugin marker into the host root's markers

set -uo pipefail

here="${BASH_SOURCE[0]%/*}"
[[ "$here" == "${BASH_SOURCE[0]}" ]] && here=.
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null
declare -F gl_log >/dev/null 2>&1 || gl_log() { :; }
unwritten() {
  gl_log "no self-plugin marker written" "$1"
  exit 0
}
# shellcheck source=scripts/lib/self-plugin-marker.sh
source "$here/lib/self-plugin-marker.sh" 2>/dev/null ||
  unwritten "lib/self-plugin-marker.sh did not load"

marker=""
spm_marker_path marker || unwritten "$marker"
# Braced so 2>/dev/null is in force before `>` fails: bash redirects left to
# right, and its own error line would otherwise reach stderr (#2626).
{ : >"$marker"; } 2>/dev/null || unwritten "$marker unwritable"
exit 0
