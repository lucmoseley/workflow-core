#!/usr/bin/env bash
# self-plugin-marker.sh — the path of a session's self-plugin marker (#2438).
#
# SOURCED, NEVER RUN.
# shellcheck source=scripts/lib/marker-root.sh
source "$(dirname "${BASH_SOURCE[0]}")/marker-root.sh" 2>/dev/null

# spm_marker_path <out-var> — reads the hook payload on stdin and sets
# <out-var> to `.self-plugin-loaded-<session id>` under gr_markers_dir, the id
# sanitised to `[A-Za-z0-9_-]`. On failure sets it to the cause and returns 1.
spm_marker_path() {
  local -n _spm_out="$1"
  local sid markers
  declare -F gr_markers_dir >/dev/null 2>&1 || {
    _spm_out="lib/marker-root.sh did not load"
    return 1
  }
  command -v jq >/dev/null 2>&1 || {
    _spm_out="jq not found"
    return 1
  }
  sid="$(jq -j '.session_id // ""' 2>/dev/null)" || {
    _spm_out="the hook input did not parse as JSON"
    return 1
  }
  sid="${sid//[^A-Za-z0-9_-]/_}"
  [[ -n "$sid" ]] || {
    _spm_out="the hook input carried no session id"
    return 1
  }
  markers="$(gr_markers_dir)"
  [[ -n "$markers" ]] || {
    _spm_out="the repo root did not resolve"
    return 1
  }
  _spm_out="$markers/.self-plugin-loaded-$sid"
}
