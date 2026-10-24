#!/usr/bin/env bash
# link-sub-issue.sh <parent> <child> — make <child> a sub-issue of <parent>.
#
# WHY A SCRIPT. The hand-assembled call fails SILENTLY (mantahostels#1150, the build; the
# rules it encodes are docs/agents/issue-tracker.md, "Placing a new issue"):
#
#  - `-f sub_issue_id=<id>` sends the id as a JSON string where the endpoint
#    wants an integer. The link is never made, and in a loop `&& echo` simply
#    skips, so nothing prints. Only `-F` sends a number.
#  - `-F sub_issue_id=$(gh api …)` sends an EMPTY STRING when the inner call
#    hits a transient network error, and the 422 then complains about the type,
#    hiding the real cause. So the id is resolved into a variable and asserted
#    numeric before the POST.
#  - `parent_issue_url` on the child lags the POST by minutes, so verification
#    reads from the PARENT side, which already lists the child while the child
#    still reads empty. The parent side is expected to answer at once; the
#    retries below cover propagation only and their count is an unmeasured
#    guess, NOT the minutes-long lag on the child side.
#  - A 422 naming an existing parent is PROOF THE FIRST CALL WORKED. Never
#    re-POST on it.
#
# EXIT 0 only where the link is in place. Anything else exits non-zero WITH a
# message on stderr.
#
# Test seams: WFC_LINK_RETRIES (verification attempts), WFC_LINK_SLEEP
# (seconds between them), WFC_LINK_REPO (owner/name, else the origin remote).

set -euo pipefail

die() {
  printf 'link-sub-issue: %s\n' "$1" >&2
  exit 1
}

[[ $# -eq 2 ]] || die "usage: link-sub-issue.sh <parent> <child>"

parent="${1#\#}"
child="${2#\#}"
[[ "$parent" =~ ^[0-9]{1,9}$ ]] || die "parent '$1' is not an issue number"
[[ "$child" =~ ^[0-9]{1,9}$ ]] || die "child '$2' is not an issue number"
[[ "$parent" != "$child" ]] || die "an issue cannot be its own parent (#$parent)"

# One named injection point for the binary, as scripts/lib/gh.js has.
gh="${WFC_GH:-gh}"
command -v "$gh" >/dev/null 2>&1 || die "$gh not found on PATH"

# The HOST repo, through the one seam (#1): CLAUDE_PROJECT_DIR, else the git top
# level of the working directory. NOT this script's own directory, which in a
# plugin install is the plugin cache and not a repository at all — the remote
# read then failed on an https remote as readily as an ssh one, which is what
# made finding F15 of the adoption dry run ("ssh-form remotes") a misdiagnosis
# of finding F23.
# shellcheck source=scripts/lib/guard-root.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/guard-root.sh"
repo="${WFC_LINK_REPO:-}"
if [[ -z "$repo" ]]; then
  url="$(git -C "$(gr_root)" config --get remote.origin.url 2>/dev/null)" || url=""
  [[ "${url%.git}" =~ ([^/:]+)/([^/]+)$ ]] ||
    die "could not read owner/name off the origin remote — pass WFC_LINK_REPO"
  repo="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
fi

retries="${WFC_LINK_RETRIES:-4}"
retry_sleep="${WFC_LINK_SLEEP:-2}"

# Does the parent already list this child?
parent_lists_child() {
  "$gh" api "repos/$repo/issues/$parent/sub_issues" --paginate \
    --jq '.[].number' 2>/dev/null |
    grep -qx "$child"
}

# The same read, retried. BOTH callers need the retry, not just the one after a
# successful POST: a single read inside the propagation window makes an
# already-correct link look like a link to some other parent.
wait_for_link() {
  local i
  for ((i = 0; i < retries; i++)); do
    parent_lists_child && return 0
    sleep "$retry_sleep"
  done
  return 1
}

# The child's numeric database id — NOT its #number, which the endpoint rejects.
db_id="$("$gh" api "repos/$repo/issues/$child" --jq '.id' 2>/dev/null)" || db_id=""
[[ "$db_id" =~ ^[0-9]+$ ]] ||
  die "could not resolve the database id of #$child (got '${db_id}') — nothing was POSTed"

# -F, never -f.
status=0
out="$("$gh" api --method POST "repos/$repo/issues/$parent/sub_issues" \
  -F "sub_issue_id=$db_id" 2>&1)" || status=$?

if ((status != 0)); then
  case "$out" in
    # The one failure that means the opposite of what it says: the child is
    # already parented. KNOWN RESIDUAL: both 422s below are matched on gh's
    # stderr prose, GitHub's status code being 422 for either. A reword demotes
    # this case to the generic failure at the foot, which is the one place a
    # reader might re-POST by hand.
    *"only have one parent"*)
      if wait_for_link; then
        printf '#%s was already a sub-issue of #%s\n' "$child" "$parent"
        exit 0
      fi
      die "#$child already has a different parent — detach it first: gh api --method DELETE repos/$repo/issues/<parent>/sub_issue -F sub_issue_id=$db_id"
      ;;
    *"7 layers"*)
      die "#$parent is 7 layers deep — give #$child the SAME parent as #$parent instead, and say in its body why it is a peer (docs/agents/issue-tracker.md)"
      ;;
  esac
  die "POST failed: $out"
fi

# Verified from the PARENT side. This loop only ever reads.
if wait_for_link; then
  printf 'linked #%s as a sub-issue of #%s\n' "$child" "$parent"
  exit 0
fi

die "POST returned success but #$parent still does not list #$child after $retries reads — do NOT re-POST; check the link in the web UI"
