#!/usr/bin/env bash
#
# review-tier-trailer.sh — writes a held commit's `Review-Tier:` trailer, the
# commit's own record of its sensitive-path review (#3664, spec #1612
# §Disposition and records, Reach).
#
# IMPLICIT:  consumes the stamp scripts/review-hold-gate.sh leaves on a pass (scripts/lib/review-tier-stamp.sh names it). Where its tree is not the one this commit carries, a neighbour's `git add` moved the index under the later gates (#3905), so it runs the hold again on what the commit now carries and refuses as the hold does. A stamp naming a review then writes `Review-Tier: <tier>; areas=<a,b>; base=<sha>; tree=<sha>; paths=<p,q>` into the message file, replacing any the message already carries.
# JUSTIFIED: reach — scripts/report-remeasure-due.js counts a commit by it where no `**Review findings:**` comment names it.
# DEFEAT:    any route that skips the hold skips the trailer with it: the founder's own terminal, `HUSKY=0`; and a linked worktree's commit whose marker would not pass the hold, which it does not refuse there, has none.
#
#   bash scripts/review-tier-trailer.sh <message file>     from .husky/prepare-commit-msg
#
# FAILS OPEN on its own faults, with one stderr line logged for
# check-guard-errors.js.
#
# LIMITS
#  - A `git add` after git built the commit's tree and before this hook reads the
#    index refuses a commit that carried the reviewed tree: fail closed.
#  - A neighbour's commit in the same git directory clears the stamp, so a tree
#    moving under this commit's later gates then goes unread (#3906).
#  - A message still to be typed into $EDITOR takes the trailer on its second
#    line, which the subject then joins, so git reads no trailer there. The
#    hold runs in a session alone, which commits with a message given.
#
# EXIT: 0 pass or fail-open · 1 the hold refused the moved tree · 2 usage.

set -uo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: review-tier-trailer.sh <message file>" >&2
  exit 2
fi
msg="$1"
# A direct `sh -e` run of the hook hands no message file; nothing is held
# there, so no stamp is consumed and no fault logged.
[[ -n "$msg" ]] || exit 0

# dropped <why> [<detail>] — say this commit lands with no trailer, and log it.
dropped() {
  echo "prepare-commit-msg: $1, so this commit lands with no Review-Tier: trailer${2:+ ($2)}." >&2
  # shellcheck source=scripts/lib/guard-log.sh
  source "${BASH_SOURCE[0]%/*}/lib/guard-log.sh" 2>/dev/null &&
    gl_log "review-tier-trailer.sh: $1 — a held commit landed with no Review-Tier: trailer" "${2-}"
  exit 0
}

# shellcheck source=scripts/lib/review-tier-stamp.sh
source "${BASH_SOURCE[0]%/*}/lib/review-tier-stamp.sh" 2>/dev/null ||
  dropped "scripts/lib/review-tier-stamp.sh would not load"
gitdir="$(git rev-parse --absolute-git-dir 2>/dev/null)" ||
  dropped "git named no git directory to read the review hold's stamp from"
stamp="$(review_tier_stamp "$gitdir")"
[[ -f "$stamp" ]] || exit 0

# Consumed on read, so a stamp outliving its commit stands behind no other. Its
# second line is the trailer's value, or `unheld` where no review is owed.
consume_stamp() {
  recorded="" value=""
  { read -r recorded && read -r value; } <"$stamp"
  rm -f "$stamp"
}
consume_stamp
[[ -n "$recorded" && -n "$value" ]] || dropped "the review hold's stamp $stamp could not be read"

# git runs the hook from the top level, which a relative GIT_INDEX_FILE names.
tree="$(git write-tree 2>/dev/null)" || dropped "git could not read the staged tree"
if [[ "$recorded" != "$tree" ]]; then
  hold="${BASH_SOURCE[0]%/*}/review-hold-gate.sh"
  [[ -r "$hold" ]] || dropped "$hold is missing, so the tree that moved under the later gates goes unheld"
  how="the staged tree moved after the review hold passed, as another session staged into this index. Commit by pathspec, node ${BASH_SOURCE[0]%/*}/commit-paths.js -m <message> -- <your paths>, which that index cannot reach (rule:review-hold). Nothing was committed."
  status=0
  bash "$hold" || status=$?
  if [[ "$status" -ne 0 ]]; then
    echo "prepare-commit-msg: $how" >&2
    exit "$status"
  fi
  [[ -f "$stamp" ]] || exit 0
  consume_stamp
  if [[ "$recorded" != "$tree" ]]; then
    echo "prepare-commit-msg: $how" >&2
    exit 1
  fi
fi
[[ "$value" != unheld ]] || exit 0

out="$(git interpret-trailers --in-place --if-exists replace \
  --trailer "Review-Tier: $value" "$msg" 2>&1)" ||
  dropped "git could not write the trailer" "$out"
exit 0
