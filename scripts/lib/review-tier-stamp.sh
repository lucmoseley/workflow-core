#!/usr/bin/env bash
# review-tier-stamp.sh — the review hold's stamp: the file in the git directory
# through which scripts/review-hold-gate.sh hands a passed commit's `Review-Tier:`
# value to scripts/review-tier-trailer.sh (#3664). One per session, as a shared
# tree's git directory serves every session's commits at once (#3906).
#
# SOURCED, NEVER RUN.

# review_tier_stamp <gitdir> — print this session's stamp in <gitdir>. Prints
# nothing with no session, which leaves no stamp.
review_tier_stamp() {
  [[ -n "${CLAUDE_CODE_SESSION_ID:-}" ]] || return 0
  printf '%s/wfc-review-tier-%s\n' "$1" "${CLAUDE_CODE_SESSION_ID//[^A-Za-z0-9_-]/_}"
}

# review_tier_sweep <gitdir> — removes the stamps a day old, which dead sessions
# stranded. A day is a guess, far past any commit's gates.
review_tier_sweep() {
  find "$1" -maxdepth 1 -name 'wfc-review-tier-*' -mmin +1440 -delete
}
