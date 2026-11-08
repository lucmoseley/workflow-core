#!/usr/bin/env bash
# marker-root.sh — where per-session hook markers, rule latches and
# breadcrumbs live: `.claude/tmp/markers`, the sanctioned in-repo scratch
# directory named in `.gitignore` (mantahostels#2089) — not the host repo root
# (mantahostels#3515 F8, workflow-core#2).
#
# `scripts/lib/marker-root.js` is the JS half; BYTE-IDENTICAL OUTPUT IS THE
# CONSTRAINT, same as `guard-root.sh`/`host-root.js` (see guard-root.sh's
# header) — change the two together. gr_declared_markers_dir alone has no JS
# twin.
#
# SOURCED, NEVER RUN.
#
# EMPTY PROPAGATES, like `gr_root`'s own disarm signal — an empty `gr_root` yields an empty result here too, rather
# than falling back to a relative `.claude/tmp/...` under whatever directory
# the hook happens to be running from.
#
# THE DIRECTORY IS CREATED ON READ (`mkdir -p`), same as the JS half, so a
# first writer never races a reader that assumes the directory already
# exists. The mkdir failure is swallowed (issue workflow-core#2): a guard whose marker
# directory cannot be created still has its real job to do. The failure
# surfaces at the write that follows, not here.
_mr_here="${BASH_SOURCE[0]%/*}"
[[ "$_mr_here" == "${BASH_SOURCE[0]}" ]] && _mr_here=.
# shellcheck source=scripts/lib/guard-root.sh
source "$_mr_here/guard-root.sh" 2>/dev/null
unset _mr_here
declare -F gr_root >/dev/null 2>&1 || gr_root() { :; }

# gr_declared_markers_dir — gr_markers_dir's directory under CLAUDE_PROJECT_DIR
# as the harness handed it, never gr_root's re-point of a linked worktree at
# its main checkout (workflow-core#4487): for a per-session marker written at start and read
# for the session's life, which a mid-session merge of a newer gr_root must not
# move. gr_markers_dir's where the variable is unset. Only the shell canary and
# its writer read it.
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

# _mr_dir <root> — creates and prints <root>'s markers directory.
_mr_dir() {
  mkdir -p "$1/.claude/tmp/markers" 2>/dev/null
  printf '%s' "$1/.claude/tmp/markers"
}
