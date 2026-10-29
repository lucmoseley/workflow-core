#!/usr/bin/env bash
#
# review-tier-trailer.sh — writes a held commit's `Review-Tier:` trailer, the
# commit's own record of its sensitive-path review (#3664, spec #1612
# §Disposition and records, Reach).
#
# IMPLICIT:  consumes the git directory's `wfc-review-tier`, which scripts/review-hold-gate.sh leaves on a pass, and where its tree is the one this commit carries, writes `Review-Tier: <tier>; areas=<a,b>; base=<sha>; tree=<sha>; paths=<p,q>` into the message file, replacing any the message already carries.
# JUSTIFIED: reach — scripts/report-remeasure-due.js counts a commit by it where no `**Review findings:**` comment names it.
# DEFEAT:    any route that skips the hold skips the trailer with it: the founder's own terminal, a linked worktree, `HUSKY=0`.
#
#   bash scripts/review-tier-trailer.sh <message file>     from .husky/prepare-commit-msg
#
# FAILS OPEN on every fault, with one stderr line logged for
# check-guard-errors.js.
#
# LIMITS
#  - A message still to be typed into $EDITOR takes the trailer on its second
#    line, which the subject then joins, so git reads no trailer there. The
#    hold runs in a session alone, which commits with a message given.
#
# EXIT: 0 always, but 2 on usage.

set -uo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: review-tier-trailer.sh <message file>" >&2
  exit 2
fi
msg="$1"

# dropped <why> [<detail>] — say this commit lands with no trailer, and log it.
dropped() {
  echo "prepare-commit-msg: $1, so this commit lands with no Review-Tier: trailer${2:+ ($2)}." >&2
  # shellcheck source=scripts/lib/guard-log.sh
  source "${BASH_SOURCE[0]%/*}/lib/guard-log.sh" 2>/dev/null &&
    gl_log "review-tier-trailer.sh: $1 — a held commit landed with no Review-Tier: trailer" "${2-}"
  exit 0
}

gitdir="$(git rev-parse --absolute-git-dir 2>/dev/null)" || exit 0
stamp="$gitdir/wfc-review-tier"
[[ -f "$stamp" ]] || exit 0
# Consumed on read, so a stamp outliving its commit stands behind no other.
recorded="" value=""
{ read -r recorded && read -r value; } <"$stamp"
rm -f "$stamp"
[[ -n "$msg" ]] || exit 0
[[ -n "$recorded" && -n "$value" ]] || dropped "the review hold's stamp $stamp could not be read"

# git runs the hook from the top level, which a relative GIT_INDEX_FILE names.
tree="$(git write-tree 2>/dev/null)" || dropped "git could not read the staged tree"
[[ "$recorded" == "$tree" ]] || exit 0

out="$(git interpret-trailers --in-place --if-exists replace \
  --trailer "Review-Tier: $value" "$msg" 2>&1)" ||
  dropped "git could not write the trailer" "$out"
exit 0
