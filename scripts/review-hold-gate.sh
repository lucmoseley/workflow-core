#!/usr/bin/env bash
#
# review-hold-gate.sh — the pre-commit hold on a declared sensitive path (workflow-core#1622,
# spec workflow-core#1612 §The hold).
#
# IMPLICIT:  refuses a session's commit in the shared tree whose staged paths match a glob `sensitivePaths` declares in `.claude/workflow-core.json`, until the session's `.codereview-pass-<sid>` marker records `tier=escalated` or `tier=mission-critical`, `areas=` naming every matched area, `tree=` equal to the tree the commit carries, and `paths=` naming every path it changes; the refusal names the areas, the marker's fault and rule:review-hold.
# JUSTIFIED: fail-safe — any neighbour's push publishes shared-`main` commits, and Manta deploys every push, so a review owed on sensitive code is a hold at commit or it is too late.
# DEFEAT:    writing the marker's four lines by hand with no review behind them; `HUSKY=0` and `core.hooksPath` off .husky/_ skip it with the rest of the stack.
#
#   bash scripts/review-hold-gate.sh                  from .husky/pre-commit
#
# The tree a session records ahead of a pathspec commit is
# `node scripts/commit-paths.js --tree`'s, the one computation of it (workflow-core#1695);
# here, in the hook, `git write-tree` reads the index git built for the commit.
#
# SKIPPED, silently:
#   - with no CLAUDE_CODE_SESSION_ID: the founder's own terminal;
#   - in a linked worktree;
#   - during a rebase, a cherry-pick or `git am`, as scripts/lib/commit-route.sh
#     reads the route: replayed bytes were held when first committed.
# A session committing into a repo it did not start in is held: the
# declaration read is the committing repo's, the marker the session's own.
#
# LIMITS
#  - The declaration is read at HEAD and as staged, never from the working
#    tree, and an area either names is held: a commit can drop a declared area
#    only as the founder lands it, outside a session.
#  - `areas=` and `paths=` are comma-separated, so an area or a path whose name
#    holds a comma can never be named there.
#  - A neighbour's commit moves HEAD and so the tree a pathspec commit carries:
#    `tree=` is then recomputed, with no new review owed.
#  - An unset name under -u aborts with 127, which pre-commit's `|| exit 1`
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
[[ "$gitdir" == "$common" ]] || exit 0

# shellcheck source=scripts/lib/commit-route.sh
source "$here/lib/commit-route.sh" 2>/dev/null ||
  unchecked "could not load scripts/lib/commit-route.sh"
wfc_commit_route_replays "$(wfc_commit_route pre-commit "$gitdir")" && exit 0

# git hands a plain commit's hook `.git/index`, relative to this cwd.
if [[ -n "${GIT_INDEX_FILE:-}" && "$GIT_INDEX_FILE" != /* ]]; then
  export GIT_INDEX_FILE="$PWD/$GIT_INDEX_FILE"
fi

work="$(mktemp -d)" || unchecked "could not make a temporary directory"
trap 'rm -rf "$work"' EXIT
# --no-renames: a rename off a sensitive path is a change to it too.
git -c core.quotePath=false diff --cached --name-only --no-renames -z >"$work/paths" ||
  unchecked "could not list the staged paths"
[[ -s "$work/paths" ]] || exit 0

# areas_under <rev> — the areas the declaration at <rev> (`HEAD`, or empty for
# the index) holds the staged paths under, one per line. An absent copy
# declares nothing.
areas_under() {
  local root="$work/root$1"
  mkdir -p "$root/.claude" || return 1
  git show "$1:.claude/workflow-core.json" >"$root/.claude/workflow-core.json" 2>/dev/null ||
    rm -f "$root/.claude/workflow-core.json"
  CLAUDE_PROJECT_DIR="$root" node "$here/lib/sensitive-paths.js" --stdin --names \
    <"$work/paths" 2>"$work/fault"
}
areas_out="$(areas_under HEAD && areas_under '')" ||
  unchecked "could not match the staged paths against sensitivePaths" "$(head -c "${GL_DETAIL_MAX:-300}" "$work/fault")"
[[ -n "$areas_out" ]] || exit 0
mapfile -t areas < <(printf '%s\n' "$areas_out" | sort -u)

tree="$(git write-tree 2>/dev/null)" || unchecked "could not read the staged tree"

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
[[ -z "$fault" ]] && exit 0

{
  echo "pre-commit: this commit changes a declared sensitive path, and no escalated review of exactly this change is recorded (workflow-core#1622)."
  echo "  Areas touched: $(join_comma "${areas[@]}")."
  echo "  The marker $marker does not clear it: $fault."
  # shellcheck source=scripts/lib/rule-text.sh
  if source "$here/lib/rule-text.sh" 2>/dev/null && text="$(rule_text review-hold 2>/dev/null)"; then
    printf '\n%s\n\n' "$text"
  else
    echo "  The rule itself could not be read from docs/agents/rules/review-hold.txt. Read that file before going on."
  fi
  echo "pre-commit: the review hold refused this commit (rule:review-hold). Nothing was committed."
} >&2
exit 1
