#!/usr/bin/env bash

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
# #2626
{ printf '%s' "${CLAUDE_PLUGIN_ROOT:-}" >"$marker"; } 2>/dev/null || unwritten "$marker unwritable"
exit 0
