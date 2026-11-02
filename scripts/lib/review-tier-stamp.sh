# shellcheck shell=bash
# review-tier-stamp.sh — where the review hold leaves its stamp for
# scripts/review-tier-trailer.sh: one file per session, as a shared tree's git
# directory serves every session's commits at once (#3906).
#
# Sourced, never run.

# wfc_review_tier_stamp <gitdir> — this session's stamp. Prints nothing with no
# session, which leaves no stamp.
wfc_review_tier_stamp() {
  [[ -n "${CLAUDE_CODE_SESSION_ID:-}" ]] || return 0
  printf '%s/wfc-review-tier-%s\n' "$1" "${CLAUDE_CODE_SESSION_ID//[^A-Za-z0-9_-]/_}"
}

# wfc_review_tier_sweep <gitdir> — removes the stamps a day old, which dead
# sessions stranded. A day is a guess, far past any commit's gates.
wfc_review_tier_sweep() {
  find "$1" -maxdepth 1 -name 'wfc-review-tier-*' -mmin +1440 -delete
}
