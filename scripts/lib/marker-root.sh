#!/usr/bin/env bash
_mr_here="${BASH_SOURCE[0]%/*}"
[[ "$_mr_here" == "${BASH_SOURCE[0]}" ]] && _mr_here=.
# shellcheck source=scripts/lib/guard-root.sh
source "$_mr_here/guard-root.sh" 2>/dev/null
unset _mr_here
declare -F gr_root >/dev/null 2>&1 || gr_root() { :; }

gr_declared_markers_dir() {
  local root
  [[ -n "${CLAUDE_PROJECT_DIR:-}" ]] || {
    gr_markers_dir
    return
  }
  root="${CLAUDE_PROJECT_DIR%/}"
  root="${root:-/}"
  root="$(gr_physical "$root" 2>/dev/null)" || root="${CLAUDE_PROJECT_DIR%/}"
  _mr_dir "$root"
}

gr_markers_dir() {
  local root
  root="$(gr_root)"
  [[ -n "$root" ]] || return 0
  _mr_dir "$root"
}

_mr_dir() {
  mkdir -p "$1/.claude/tmp/markers" 2>/dev/null
  printf '%s' "$1/.claude/tmp/markers"
}
