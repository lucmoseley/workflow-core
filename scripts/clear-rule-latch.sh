#!/usr/bin/env bash
# clear-rule-latch.sh — drop this session's rule-injection latches when its
# context is about to be compacted (mantahostels#1804, spec mantahostels#1762).
#
# The clear is unconditional on `trigger`: an auto-compaction drops context for
# the same reason a manual one does.
#
# EVERY FAILURE IS SILENT AND EXITS 0.
#
# A SUBAGENT'S LATCHES GO WITH THE PARENT'S. They are keyed `-a<agent_id>-<sid>`
# and so match the same glob.
#
# IMPLICIT:  at every compaction, deletes this session's (and its subagents') rule-injection latch markers from .claude/tmp/markers, so each relocated rule is handed to the session once more after its context is cut.
# JUSTIFIED: fail-safe — a latch outliving the text it latched leaves a session holding neither the rule nor any prospect of being given it, which is worse than never having injected it.
# DEFEAT:    none; remove the PreCompact entry in self-plugin/hooks/hooks.json to turn it off.

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
# The one fault not recorded: an empty payload is nothing to clear rather than
# something this hook failed to read.
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
# The id reaches a glob, so anything outside its own alphabet is replaced —
# lib/guard-entry.js's segment() sanitised it the same way when it wrote the
# marker.
sid="${sid//[^A-Za-z0-9_-]/_}"

# gr_markers_dir is the bash twin of lib/marker-root.js's markersDir, which
# lib/guard-entry.js writes the latch under (mantahostels#1905);
# clear-rule-latch.test.ts holds the two in agreement. Under
# .claude/tmp/markers rather than the repo root since F8 (mantahostels#3515, #2).
markers="$(gr_markers_dir)"
# Empty is gr_root's disarm signal propagated through gr_markers_dir, and it
# reaches here only when guard-root.sh itself failed to load. Unrecorded, like
# every other fault in this file: globbing from / would ask about a directory
# the hook has no business in, and whether gl_log survives that same failure
# is not knowable from here.
[[ -n "$markers" ]] || exit 0
shopt -s nullglob
for f in "$markers"/.rule-injected-*-"$sid"; do
  rm -f "$f" 2>/dev/null
done
exit 0
