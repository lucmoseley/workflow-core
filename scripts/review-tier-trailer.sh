#!/usr/bin/env bash
#
# review-tier-trailer.sh — writes a held commit's `Review-Tier:` trailer, the
# commit's own record of its sensitive-path review (#3664, spec #1612
# §Disposition and records, Reach).
#
# IMPLICIT:  removes every `Review-Tier:` line from the message but one a cherry-pick's picked commit carries or, on an unchanged tree, HEAD's, saying so on stderr where the commit then goes on with none (#3906). Consumes this session's stamp scripts/review-hold-gate.sh leaves on a pass (scripts/lib/review-tier-stamp.sh names it). Where its tree is not the one this commit carries, a neighbour's `git add` moved the index under the later gates (#3905), so it runs the hold again on what the commit now carries and refuses as the hold does. A stamp naming a review then writes `Review-Tier: <tier>; areas=<a,b>; base=<sha>; tree=<sha>; paths=<p,q>` into the message file.
# JUSTIFIED: reach — scripts/report-remeasure-due.js counts a commit by it where no `**Review findings:**` comment names it.
# DEFEAT:    any route that skips the hold skips the trailer with it: the founder's own terminal and `HUSKY=0`.
#
#   bash scripts/review-tier-trailer.sh <message file>     from .husky/prepare-commit-msg
#
# FAILS OPEN on its own faults, with one stderr line logged for
# check-guard-errors.js.
#
# LIMITS
#  - A `git add` after git built the commit's tree and before this hook reads the
#    index refuses a commit that carried the reviewed tree: fail closed.
#  - A `Review-Tier:` line typed into $EDITOR survives, as this hook runs before
#    the editor opens. A session commits with a message given.
#  - `--no-verify` by hand mid-rebase reaches the replay path, never this script.
#  - One session's two simultaneous commits share a stamp.
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

# unstripped <why> — a line that may be false stands: say so, and log it.
unstripped() {
  echo "prepare-commit-msg: $1, so a Review-Tier: line in the message stands unvouched." >&2
  # shellcheck source=scripts/lib/guard-log.sh
  source "${BASH_SOURCE[0]%/*}/lib/guard-log.sh" 2>/dev/null &&
    gl_log "review-tier-trailer.sh: $1 — a Review-Tier: line stands unvouched"
  exit 0
}

# vouching_message <route> — the one message whose `Review-Tier:` line this commit
# may keep: a cherry-pick's picked commit, or HEAD's where the tree is HEAD's, as
# a reword changes nothing reviewed. A rebase's replays never reach this script,
# so a commit on that route is by hand.
vouching_message() {
  case "$1" in
    cherry-pick) git log -1 --format=%B CHERRY_PICK_HEAD 2>/dev/null ;;
    rebase) ;;
    *)
      if [[ "$(git rev-parse -q --verify 'HEAD^{tree}' 2>/dev/null)" == "$(git write-tree 2>/dev/null)" ]]; then
        git log -1 --format=%B HEAD 2>/dev/null
      fi
      ;;
  esac
}

# strip_unvouched <route> — removes each `Review-Tier:` line the vouching message
# does not carry, in any spelling git reads as this key: any case, space before
# the colon, folded lines.
stripped=""
strip_unvouched() {
  local status=0 original kept
  [[ -n "$msg" ]] || return 0
  grep -qiE '^Review-Tier[[:space:]]*:' "$msg" 2>/dev/null || status=$?
  [[ "$status" -ne 1 ]] || return 0
  [[ "$status" -eq 0 ]] || unstripped "could not read the message file $msg"
  original="$(cat "$msg")" || unstripped "could not read the message file $msg"
  kept="$(VOUCHING="$(vouching_message "$1")" awk '
    BEGIN { n = split(ENVIRON["VOUCHING"], v, "\n"); for (i = 1; i <= n; i++) vouched[v[i]] = 1 }
    tolower($0) ~ /^review-tier[ \t]*:/ { dropping = !($0 in vouched); if (dropping) next }
    dropping && /^[ \t]/ { next }
    { dropping = 0; print }' "$msg")" || unstripped "could not filter the message file $msg"
  [[ "$kept" != "$original" ]] || return 0
  printf '%s\n' "$kept" >"$msg" || unstripped "could not rewrite the message file $msg"
  stripped=1
}

# On a commit that goes on with no trailer, says the strip took one away.
wrote=""
# shellcheck disable=SC2329  # run by the EXIT trap below
say_stripped() {
  local status=$?
  if [[ "$status" -eq 0 && -n "$stripped" && -z "$wrote" ]]; then
    echo "prepare-commit-msg: removed the message's Review-Tier: line, as no review of this commit is recorded; only the review hold writes one." >&2
  fi
}
trap say_stripped EXIT

# The route's own library failing to load strips on every route, as no message
# can then vouch; pre-commit and prepare-commit-msg refuse a commit without it.
route=rebase
gitdir="$(git rev-parse --absolute-git-dir 2>/dev/null)" || gitdir=""
# shellcheck source=scripts/lib/commit-route.sh
if [[ -n "$gitdir" ]] && source "${BASH_SOURCE[0]%/*}/lib/commit-route.sh" 2>/dev/null; then
  route="$(wfc_commit_route prepare-commit-msg "$gitdir")"
fi
strip_unvouched "$route"
[[ -n "$gitdir" ]] || dropped "git named no git directory to read the review hold's stamp from"

# shellcheck source=scripts/lib/review-tier-stamp.sh
source "${BASH_SOURCE[0]%/*}/lib/review-tier-stamp.sh" 2>/dev/null ||
  dropped "scripts/lib/review-tier-stamp.sh would not load"
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
wrote=1
exit 0
