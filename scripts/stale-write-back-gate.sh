#!/usr/bin/env bash
#
# stale-write-back-gate.sh — the pre-commit stale-write-back gate (#113, spec #100).
#
# IMPLICIT:  refuses a session's commit where any path it MODIFIES is staged nearer the session's base than HEAD — the rule is session-arbiter.js `stale-check`'s — naming the path, the neighbour commits since the base and the two ways forward.
# JUSTIFIED: fail-safe — a pathspec or private-index commit writes back whatever version the session last read, undoing a neighbour's committed edit with every other gate green (mantahostels#2557).
# DEFEAT:    per path, `node scripts/session-arbiter.js accept-head <path>`, which is logged for the founder.
#
# Runs from .husky/pre-commit, so `--no-verify` does not skip it:
# .husky/prepare-commit-msg re-runs that file (mantahostels#1705). Every git read goes
# through the index GIT_INDEX_FILE names, which git sets for the hook.
#
# SKIPPED, silently:
#   - with no CLAUDE_CODE_SESSION_ID: nobody's base to judge against;
#   - during a rebase, a cherry-pick or `git am` — the stack's narrow replay
#     path (.husky/prepare-commit-msg), and a commit made by hand mid-sequence
#     with it, as scripts/lib/commit-route.sh reads the route: replayed bytes
#     are old by design;
#   - in a linked worktree, whose HEAD is not the shared tree's the bases were
#     taken against, or in any repo but the session's own — scripts/lib/shared-tree-skip.sh,
#     which .husky/post-commit's base advance stands down on too (#123).
#
# FAILS OPEN (mantahostels#103 §6) with one stderr line, logged for
# check-guard-errors.js: a store or git fault, reported by the arbiter itself; and
# a timeout or a crash, reported here. The bound is 5 s, as commit-paths.js
# gives its own arbiter call.
#
# EXIT: 0 pass or fail-open · 1 refuse. LIMITS: an unset name under -u aborts
# with 127, which pre-commit's `|| exit 1` turns into a refusal with no gl_log
# line — fail closed, since a gate reading a name it never set is a bug in it.

set -uo pipefail

# shellcheck source=scripts/lib/guard-log.sh
source "${BASH_SOURCE[0]%/*}/lib/guard-log.sh" 2>/dev/null
declare -F gl_log >/dev/null 2>&1 || gl_log() { :; }
# shellcheck source=scripts/lib/rule-text.sh
source "${BASH_SOURCE[0]%/*}/lib/rule-text.sh" 2>/dev/null
# shellcheck source=scripts/lib/shared-tree-skip.sh
source "${BASH_SOURCE[0]%/*}/lib/shared-tree-skip.sh" 2>/dev/null
# shellcheck source=scripts/lib/commit-route.sh
source "${BASH_SOURCE[0]%/*}/lib/commit-route.sh" 2>/dev/null

[[ -n "${CLAUDE_CODE_SESSION_ID:-}" ]] || exit 0

# A missing library is a gate that cannot decide, reported like a git that will
# not answer.
missing=""
if ! declare -F wfc_shared_tree_skip >/dev/null 2>&1; then
  missing=scripts/lib/shared-tree-skip.sh
elif ! declare -F wfc_commit_route >/dev/null 2>&1; then
  missing=scripts/lib/commit-route.sh
fi
if [[ -n "$missing" ]]; then
  stand_down=3
else
  wfc_shared_tree_skip
  stand_down=$?
fi
case "$stand_down" in
  0) ;;
  2)
    echo "pre-commit: the stale-write-back gate could not read the git directory — this commit is NOT checked. See: node ${WFC_PLUGIN_ROOT:+$WFC_PLUGIN_ROOT/}scripts/check-guard-errors.js" >&2
    gl_log "git rev-parse failed — a commit went unchecked for a stale write-back"
    exit 0
    ;;
  3)
    echo "pre-commit: the stale-write-back gate could not read $missing — this commit is NOT checked. See: node ${WFC_PLUGIN_ROOT:+$WFC_PLUGIN_ROOT/}scripts/check-guard-errors.js" >&2
    gl_log "$missing missing or unreadable — a commit went unchecked for a stale write-back"
    exit 0
    ;;
  *) exit 0 ;;
esac

wfc_commit_route_replays "$(wfc_commit_route pre-commit "$wfc_sts_gitdir")" && exit 0

# git hands a plain commit's hook `.git/index`, relative to this cwd.
if [[ -n "${GIT_INDEX_FILE:-}" && "$GIT_INDEX_FILE" != /* ]]; then
  export GIT_INDEX_FILE="$PWD/$GIT_INDEX_FILE"
fi

bound="${WFC_STALE_GATE_BOUND:-5}"
arbiter="${BASH_SOURCE[0]%/*}/session-arbiter.js"
# Held, not streamed: `stale-check` speaks on stderr alone, and a crash's stack
# trace is not what the fail-open's one line should arrive under.
if command -v timeout >/dev/null 2>&1; then
  said="$(timeout "$bound" node "$arbiter" stale-check --staged 2>&1 >/dev/null)"
else
  said="$(node "$arbiter" stale-check --staged 2>&1 >/dev/null)"
fi
rc=$?

case "$rc" in
  0)
    [[ -z "$said" ]] || printf '%s\n' "$said" >&2
    exit 0
    ;;
  3)
    printf '%s\n' "$said" >&2
    if declare -F rule_text >/dev/null 2>&1 && text="$(rule_text stale-write-back 2>/dev/null)"; then
      printf '\n%s\n\n' "$text" >&2
    else
      echo "pre-commit: the rule itself could not be read from docs/agents/rules/stale-write-back.txt. Read that file before choosing." >&2
    fi
    echo "pre-commit: the stale-write-back gate refused this commit (#100, rule:stale-write-back). Nothing was committed." >&2
    exit 1
    ;;
  124) why="timed out at ${bound}s" ;;
  *) why="exited $rc" ;;
esac
echo "pre-commit: the stale-write-back check $why — this commit is NOT checked. See: node ${WFC_PLUGIN_ROOT:+$WFC_PLUGIN_ROOT/}scripts/check-guard-errors.js" >&2
gl_log "session-arbiter.js stale-check --staged $why — a commit went unchecked for a stale write-back"
exit 0
