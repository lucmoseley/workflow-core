#!/usr/bin/env bash
# marker-root.sh — where per-session hook markers, rule latches and
# breadcrumbs live: `.claude/tmp/markers`, the sanctioned in-repo scratch
# directory named in `.gitignore` (mantahostels#2089) — not the host repo root
# (mantahostels#3515 F8, workflow-core#2).
#
# `scripts/lib/marker-root.js` is the JS half; BYTE-IDENTICAL OUTPUT IS THE
# CONSTRAINT, same as `guard-root.sh`/`host-root.js` (see guard-root.sh's
# header) — change the two together.
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
# shellcheck source=scripts/lib/guard-root.sh
source "$(dirname "${BASH_SOURCE[0]}")/guard-root.sh" 2>/dev/null
declare -F gr_root >/dev/null 2>&1 || gr_root() { :; }

gr_markers_dir() {
  local root
  root="$(gr_root)"
  [[ -n "$root" ]] || return 0
  mkdir -p "$root/.claude/tmp/markers" 2>/dev/null
  printf '%s' "$root/.claude/tmp/markers"
}
