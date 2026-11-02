#!/usr/bin/env bash
#
# review-hold-gate.sh — the pre-commit hold on a declared sensitive path (#1622,
# spec #1612 §The hold).
#
# IMPLICIT:  refuses a session's commit in the shared tree whose staged paths match a glob `sensitivePaths` declares in `.claude/workflow-core.json`, or that removes an area from that declaration or a glob from one (#3905), until the session's `.codereview-pass-<sid>` marker records `tier=escalated` or `tier=mission-critical`, `areas=` naming every matched area, `tree=` equal to the tree the commit carries, and `paths=` naming every path it changes; the refusal names the areas, the marker's fault and rule:review-hold. On a pass, in a linked worktree too, it leaves the marker's tier, areas, base, tree and paths in the session's own `wfc-review-tier-<sid>` in the git directory, so a neighbour's commit neither clears nor consumes it (#3906), keyed to that tree, for scripts/review-tier-trailer.sh to write as the commit's `Review-Tier:` trailer (#3664).
# JUSTIFIED: fail-safe — any neighbour's push publishes shared-`main` commits, and Manta deploys every push, so a review owed on sensitive code is a hold at commit or it is too late.
# DEFEAT:    writing the marker's four lines by hand with no review behind them; `HUSKY=0` and `core.hooksPath` off .husky/_ skip it with the rest of the stack.
#
#   bash scripts/review-hold-gate.sh                  from .husky/pre-commit
#
# The tree a session records ahead of a pathspec commit is
# `node scripts/commit-paths.js --tree`'s, the one computation of it (#1695);
# here, in the hook, `git write-tree` reads the index git built for the commit.
#
# SKIPPED, silently:
#   - with no CLAUDE_CODE_SESSION_ID: the founder's own terminal;
#   - a replay route in a linked worktree, as scripts/lib/commit-route.sh reads
#     the route.
# A CHERRY-PICK counts only the paths whose staged change differs from the picked
# commit's own (#3905). Any other replay route reaching this is held whole.
# A session committing into a repo it did not start in is held: the
# declaration read is the committing repo's, the marker the session's own.
#
# A LINKED WORKTREE is held to nothing (#3714): the same check runs, a marker
# that would pass leaves the stamp, and one that would not passes, naming on
# stderr why the commit lands with no trailer (#3830). With no marker at all it
# passes in silence.
#
# LIMITS
#  - The declaration is read at HEAD and as staged, never from the working
#    tree, and an area either names is held. A commit narrowing it is held under
#    what it drops, but a linked worktree's lands.
#  - A replay reaching no pre-commit is unheld: `git am`; a `git rebase`,
#    `--continue` included, which a guard refuses in the shared tree; and a
#    `--no-verify` commit, which a guard refuses unwrapped, beside a hand-made
#    `rebase-merge`.
#  - A pick whose glob paths change as the picked commit changed them passes,
#    conflict elsewhere or not: of a worktree's unreviewed commit too, and under
#    a forged CHERRY_PICK_HEAD naming one that carries the same change. A
#    `git cherry-pick -m 2` reads against the first parent, so it is held.
#  - A HEAD whose declaration will not parse holds nothing: it fails open.
#  - A staged declaration that will not parse fails closed where HEAD declares an
#    area, not open as the gate's other faults do: dropping every area by a typo
#    is the narrowing this hold exists for (#3905).
#  - `areas=` and `paths=` are comma-separated, so an area or a path whose name
#    holds a comma can never be named there.
#  - A neighbour's commit moves HEAD and so the tree a pathspec commit carries:
#    `tree=` is then recomputed, with no new review owed.
#  - An unset name under -u aborts with 127, which pre-commit's `|| exit "$?"`
#    turns into a refusal with no gl_log line: fail closed.
#
# FAILS OPEN on its own faults — git that will not answer, a library or the
# matcher that will not run — with one stderr line, logged for
# check-guard-errors.js.
#
# EXIT: 0 pass, skip or fail-open · 1 refuse · 2 usage.

set -uo pipefail

here="${BASH_SOURCE[0]%/*}"

if [[ $# -gt 0 ]]; then
  echo "usage: review-hold-gate.sh   (no arguments; the tree a commit carries is node scripts/commit-paths.js --tree's)" >&2
  exit 2
fi

[[ -n "${CLAUDE_CODE_SESSION_ID:-}" ]] || exit 0

# shellcheck source=scripts/lib/gate-unchecked.sh
source "$here/lib/gate-unchecked.sh" 2>/dev/null || {
  echo "pre-commit: the review hold could not load scripts/lib/gate-unchecked.sh — this commit is NOT checked." >&2
  # shellcheck source=scripts/lib/guard-log.sh
  source "$here/lib/guard-log.sh" 2>/dev/null &&
    gl_log "review-hold-gate.sh: could not load scripts/lib/gate-unchecked.sh — a commit went unchecked for a sensitive-path review"
  exit 0
}
gate_unchecked_as "the review hold" "a commit went unchecked for a sensitive-path review"

if ! gitdir="$(git rev-parse --absolute-git-dir 2>/dev/null)" ||
  ! common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"; then
  unchecked "could not read the git directory"
fi

# shellcheck source=scripts/lib/commit-route.sh
source "$here/lib/commit-route.sh" 2>/dev/null ||
  unchecked "could not load scripts/lib/commit-route.sh"
# shellcheck source=scripts/lib/review-tier-stamp.sh
source "$here/lib/review-tier-stamp.sh" 2>/dev/null ||
  unchecked "could not load scripts/lib/review-tier-stamp.sh"
# Cleared on every run, so a stamp a later gate's refusal stranded stands behind
# no commit the hold does not pass.
stamp="$(wfc_review_tier_stamp "$gitdir")"
rm -f "$stamp" 2>/dev/null ||
  gl_log "review-hold-gate.sh: could not remove $stamp — a stranded stamp may stand behind this commit"
wfc_review_tier_sweep "$gitdir" 2>/dev/null ||
  gl_log "review-hold-gate.sh: could not sweep $gitdir's dead sessions' review-tier stamps"
route="$(wfc_commit_route pre-commit "$gitdir")"
if wfc_commit_route_replays "$route" && [[ "$gitdir" != "$common" ]]; then exit 0; fi

# git hands a plain commit's hook `.git/index`, relative to this cwd.
if [[ -n "${GIT_INDEX_FILE:-}" && "$GIT_INDEX_FILE" != /* ]]; then
  export GIT_INDEX_FILE="$PWD/$GIT_INDEX_FILE"
fi

work="$(mktemp -d)" || unchecked "could not make a temporary directory"
trap 'rm -rf "$work"' EXIT
# --no-renames: a rename off a sensitive path is a change to it too.
git -c core.quotePath=false diff --cached --name-only --no-renames -z >"$work/paths" ||
  unchecked "could not list the staged paths"

tree="$(git write-tree 2>/dev/null)" || unchecked "could not read the staged tree"

# pass_with_stamp <value> <what is lost> — passes, leaving the tree and <value>
# for scripts/review-tier-trailer.sh. Fails open: a stamp unwritten costs what
# it names, never the pass.
pass_with_stamp() {
  printf '%s\n%s\n' "$tree" "$1" >"$stamp" 2>/dev/null || {
    rm -f "$stamp"
    echo "pre-commit: could not write $stamp, so this commit lands with $2." >&2
    gl_log "review-hold-gate.sh: could not write $stamp — a commit lands with $2"
  }
  exit 0
}
# pass_unheld — this commit owes no review. `unheld` tells the trailer script to
# write nothing, and only to see whether the tree moved under the later gates.
pass_unheld() {
  pass_with_stamp unheld "no check that its tree stayed put under the later gates"
}
[[ -s "$work/paths" ]] || pass_unheld

# change_of <diff args…> — a diff with what only says where it applies removed:
# context, blob ids and hunk positions, which differ once the base has moved.
change_of() {
  git -c core.quotePath=false diff --no-color --no-ext-diff --no-textconv \
    --no-renames --binary -U0 "$@" | sed -E -e '/^index /d' -e 's/^@@ .*$/@@/'
}

# unreplayed — the staged paths, NUL-separated, whose staged change is not the
# one CHERRY_PICK_HEAD made to them.
unreplayed() {
  local pick parent path staged picked
  pick="$(git rev-parse -q --verify CHERRY_PICK_HEAD)" || return 1
  if ! parent="$(git rev-parse -q --verify "$pick^")"; then
    cat "$work/paths"
    return 0
  fi
  while IFS= read -r -d '' path; do
    staged="$(change_of --cached HEAD -- "$path")" || return 1
    picked="$(change_of "$parent" "$pick" -- "$path")" || return 1
    [[ "$staged" == "$picked" ]] || printf '%s\0' "$path"
  done <"$work/paths"
}

# The paths the hold reads: `paths=` still names all of them.
held="$work/paths"
if [[ "$route" == cherry-pick ]]; then
  held="$work/unreplayed"
  unreplayed >"$held" || unchecked "could not compare the staged change with the picked commit's"
  [[ -s "$held" ]] || pass_unheld
fi

# areas_under <rev> — the areas the declaration at <rev> (`HEAD`, or empty for
# the index) holds the staged paths under, one per line. An absent copy
# declares nothing.
root_of() { printf '%s' "$work/root$1"; }
areas_under() {
  local root
  root="$(root_of "$1")"
  mkdir -p "$root/.claude" || return 1
  git show "$1:.claude/workflow-core.json" >"$root/.claude/workflow-core.json" 2>/dev/null ||
    rm -f "$root/.claude/workflow-core.json"
  CLAUDE_PROJECT_DIR="$root" node "$here/lib/sensitive-paths.js" --stdin --names \
    <"$held" 2>"$work/fault"
}
unmatched() {
  unchecked "could not match the staged paths against sensitivePaths" "$(head -c "${GL_DETAIL_MAX:-300}" "$1")"
}
areas_out="$(areas_under HEAD)" || unmatched "$work/fault"
staged_read=1
staged_areas="$(areas_under '')" || staged_read=""
staged_fault="$(cat "$work/fault")"

# A staged copy that will not parse declares nothing, so it narrows every area
# HEAD declares; with none there to drop, it stays this gate's own fault.
narrowed=""
if tr '\0' '\n' <"$held" | grep -qxF .claude/workflow-core.json; then
  narrowed="$(node "$here/lib/sensitive-paths.js" --narrowed "$(root_of HEAD)" "$(root_of '')" 2>"$work/narrow-fault")" ||
    unmatched "$work/narrow-fault"
fi
if [[ -z "$staged_read" && -z "$narrowed" ]]; then
  printf '%s' "$staged_fault" >"$work/fault"
  unmatched "$work/fault"
fi

areas_out="$(printf '%s\n%s\n%s\n' "$areas_out" "$staged_areas" "$narrowed" | sed '/^$/d')"
[[ -n "$areas_out" ]] || pass_unheld
mapfile -t areas < <(printf '%s\n' "$areas_out" | sort -u)

# shellcheck source=scripts/lib/marker-root.sh
source "$here/lib/marker-root.sh" 2>/dev/null ||
  unchecked "could not load scripts/lib/marker-root.sh"
# shellcheck source=scripts/lib/concision-marker.sh
source "$here/lib/concision-marker.sh" 2>/dev/null ||
  unchecked "could not load scripts/lib/concision-marker.sh"
markers_dir="$(gr_markers_dir)"
[[ -n "$markers_dir" ]] || unchecked "could not resolve the markers directory"
marker="$markers_dir/.codereview-pass-$CLAUDE_CODE_SESSION_ID"

fault=""
if [[ ! -f "$marker" ]]; then
  fault="there is no marker"
else
  fault="$(marker_tier_fault "$marker" "${areas[@]}")" ||
    unchecked "could not read the marker's areas= against the matched areas"
  recorded_tree="$(marker_field "$marker" tree | tr -d '[:space:]')"
  if [[ -z "$fault" && "$recorded_tree" != "$tree" ]]; then
    if [[ -z "$recorded_tree" ]]; then
      fault="it has no tree= line"
    else
      fault="its tree= is not the tree this commit carries, so something changed after it was written"
    fi
  fi
  if [[ -z "$fault" ]]; then
    # The Stop nag and the push warning read paths= as all this review saw,
    # and a marker without it as a review of the session's whole change.
    tr '\0' '\n' <"$work/paths" | marker_unlisted "$marker" paths >"$work/unnamed"
    [[ "${PIPESTATUS[1]}" -ne 2 ]] || unchecked "could not read the marker's paths= against the staged paths"
    mapfile -t unnamed <"$work/unnamed"
    if ! marker_has "$marker" paths; then
      fault="it has no paths= line"
    elif [[ -z "$(marker_list "$marker" paths)" ]]; then
      fault="its paths= names no path"
    elif [[ "${#unnamed[@]}" -gt 0 ]]; then
      fault="its paths= does not name $(join_comma "${unnamed[@]:0:NAMED_PATHS_MAX}")"
    fi
  fi
fi
if [[ -z "$fault" ]]; then
  pass_with_stamp "$(printf '%s; areas=%s; base=%s; tree=%s; paths=%s' \
    "$(marker_field "$marker" tier | tr -d '[:space:]')" \
    "$(marker_list "$marker" areas | paste -sd, -)" \
    "$(marker_field "$marker" base | tr -d '[:space:]')" "$tree" \
    "$(marker_list "$marker" paths | paste -sd, -)")" "no Review-Tier: trailer"
fi
# A linked worktree is held to nothing: only a marker that passes marks it (#3714).
if [[ "$gitdir" != "$common" ]]; then
  [[ ! -f "$marker" ]] ||
    echo "pre-commit: this commit lands with no Review-Tier: trailer. The marker $marker does not clear it: $fault. To trail it, git reset --soft HEAD~, record the review of exactly this change with scripts/write-review-marker.js, and commit again (rule:review-hold)." >&2
  exit 0
fi

{
  echo "pre-commit: this commit changes a declared sensitive path, and no escalated review of exactly this change is recorded (#1622)."
  echo "  Areas touched: $(join_comma "${areas[@]}")."
  echo "  The marker $marker does not clear it: $fault."
  if [[ -z "$staged_read" ]]; then
    echo "  The staged .claude/workflow-core.json will not read, and a review would land it broken, so correct it first: $staged_fault"
  fi
  # shellcheck source=scripts/lib/rule-text.sh
  if source "$here/lib/rule-text.sh" 2>/dev/null && text="$(rule_text review-hold 2>/dev/null)"; then
    printf '\n%s\n\n' "$text"
  else
    echo "  The rule itself could not be read from docs/agents/rules/review-hold.txt. Read that file before going on."
  fi
  echo "pre-commit: the review hold refused this commit (rule:review-hold). Nothing was committed."
} >&2
exit 1
