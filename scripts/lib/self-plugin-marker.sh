#!/usr/bin/env bash
_spm_here="${BASH_SOURCE[0]%/*}"
[[ "$_spm_here" == "${BASH_SOURCE[0]}" ]] && _spm_here=.
# shellcheck source=scripts/lib/marker-root.sh
source "$_spm_here/marker-root.sh" 2>/dev/null
unset _spm_here

spm_marker_path() {
  local -n _spm_out="$1"
  local sid markers
  declare -F gr_declared_markers_dir >/dev/null 2>&1 || {
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
  markers="$(gr_declared_markers_dir)"
  [[ -n "$markers" ]] || {
    _spm_out="the repo root did not resolve"
    return 1
  }
  _spm_out="$markers/.self-plugin-loaded-$sid"
}
