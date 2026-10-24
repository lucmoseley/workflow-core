#!/usr/bin/env bash
# PostToolUse releaser on Bash: when a session closes an issue, drop that
# session's arbiter claim on it (mantahostels#706, the build; mantahostels#645, which added the
# claim-issue store; mantahostels#646, the recorder this pairs with).
#
# WHY A HOOK AND NOT A RULE. docs/agents/issue-tracker.md and
# .claude/skills/pick-next/SKILL.md both said "release with `release-issue <n>`
# at the close", and no close path ever called it: /card-close releases the two
# roadmap files it holds and nothing else. A claim outliving its issue leaves
# `session-arbiter.js issue-claims` — the one place a person looks to see what is
# being worked — listing closed issues within a session or two.
#
# The close has one identifiable moment, `gh issue close <n>`, so a hook can read
# it, exactly as mantahostels#646 reads `gh issue edit <n> --add-assignee @me`.
#
# IT ONLY EVER RELEASES. Nothing is refused, nothing is injected, and every
# failure path exits 0 in silence. A release that fails to write leaves the claim
# standing, which costs a stale line in `issue-claims` and nothing else: the
# claim already stops excluding the issue as soon as this session dies, and
# pruneIssueClaims sweeps the record after 7 days.
#
# LIMITS
#  - A PostToolUse hook sees Bash tool calls only, so A CLOSE MADE FROM THE
#    GITHUB WEB UI, BY A SCRIPT, OR THROUGH `gh api` RELEASES NOTHING. The 7-day
#    prune is what carries those.
#  - IT DROPS THIS SESSION'S CLAIM ONLY, the arbiter refusing to take a session
#    id from argv so no caller can drop somebody else's (session-arbiter.js,
#    `case "release-issue"`). A session closing an issue a DIFFERENT session
#    claimed leaves that claim standing.
#  - A `--repo`-qualified close releases nothing: the claim store is
#    per-repository, so a number from another repository would be dropped from
#    this one. That holds EVEN WHERE --repo NAMES THIS REPOSITORY, unlike an
#    issue URL, which is matched against the origin remote and released on. The
#    flag's value is as often an alias or a variable as a literal, and the cost
#    of reading one wrong is dropping a claim this session is still working.
#  - AN ISSUE NUMBER ARRIVING AS A SHELL VARIABLE OR A COMMAND SUBSTITUTION
#    RELEASES NOTHING — `n=123; gh issue close "$n"`. This reads the command text
#    and never a shell that could expand it.
#  - It runs AFTER the command, and reads the command rather than its result, so
#    a close that failed still drops the claim. The issue becomes selectable
#    again while this session may still be working it — the same fail-open
#    direction mantahostels#633 chose, and cheaper than a claim on an issue nobody is on.
#  - Wired with `if: Bash(gh *)` (mantahostels#2127; best-effort:
#    docs/agents/guard-authoring.md's surface 4, which fails toward running)
#    — not exec'd unless some segment of the
#    command leads with `gh`. NEARLY the same test as `release()`'s own
#    basename check (:153), which differs on one spelling: `/usr/bin/gh …`
#    passes the basename and matches the anchored form in neither spelling, so
#    a path-spelled call is unjudged (mantahostels#2127).
#    Read rather than probed (mantahostels#2127): `release()` gates on the command word alone with
#    no wrapper walk, so the anchored form drops no call it acts on.
#
# IMPLICIT:  after a `gh issue close <n>`, drops this session's arbiter claim on that issue.
# JUSTIFIED: convenience — the release was written down in two places and no close path ever called it; a claim outliving its issue costs a stale line in `issue-claims` and nothing else.
# DEFEAT:    evadable by spelling — `--repo`, a shell variable, `gh api` or the web UI all miss the seam — but there is no switch.

set -uo pipefail

# Injected at its §N7 var, never by PATH, because the tests feed it a chosen
# exit code per case (#2266).
node_bin="${WFC_NODE:-node}"

# lib/guard-log.sh is sourced FIRST and separately, so the one fault that
# disarms this releaser entirely — the parser failing to load — is itself
# recordable (mantahostels#147). The gate is ONE name, `gp_begin` — never `source`'s own
# exit status. Why that is enough is on gp_begin in lib/guard-parse.sh (mantahostels#157).
here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null

# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null
declare -F gp_begin >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-parse.sh did not load — no issue claim released"
  exit 0
}

# shellcheck source=scripts/lib/guard-root.sh
source "$here/lib/guard-root.sh"

# shellcheck source=scripts/lib/gh-issue-ref.sh
source "$here/lib/gh-issue-ref.sh" 2>/dev/null
declare -F gi_issue_word >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/gh-issue-ref.sh did not load — no issue claim released"
  exit 0
}

gp_begin '.tool_input.command' command

# The matcher in self-plugin/hooks/hooks.json already scopes this to Bash; the test
# drives the hook directly, and a payload from any other tool carries a command
# field that means something else.
[[ "$(gp_payload_field '.tool_name // "Bash"')" == "Bash" ]] || exit 0

# The claim is dropped for the session that made the close, and the arbiter takes
# that from the environment rather than from argv.
session="$(gp_payload_field '.session_id // ""')"
[[ -n "$session" ]] || session="${CLAUDE_CODE_SESSION_ID:-}"
[[ -n "$session" ]] || exit 0

# Recorded, not silent: with node gone this hook releases nothing for as long as
# that lasts (mantahostels#147).
command -v "$node_bin" >/dev/null 2>&1 ||
  gl_open "node not found — no issue claim released"

# `timeout` is what keeps a wedged arbiter inside the hook's budget, but it is
# not worth abandoning the release when the binary is missing — refresh-claims.sh
# makes the same call for the same reason.
bounded=""
command -v timeout >/dev/null 2>&1 && bounded=1

# The flags `gh issue close` takes a value for, short and long together. Leave
# one out and its value is read as a bare word — `--reason 646` would then drop
# the claim on mantahostels#646.
CLOSE_VALUE_FLAGS="-c --comment -r --reason -R --repo"

# One argument of a `gh issue close`, as <kind> <name> <value>. Sets $scoped and
# appends to $issues.
close_arg() {
  case "$1" in
    opt) case "$2" in -R | --repo) scoped=1 ;; esac ;;
    # `dangling` is a value-taking flag with no value left to take, and is the
    # only other kind --repo can arrive as, being in the spec above.
    dangling) [[ "$2" == -R || "$2" == --repo ]] && scoped=1 ;;
    arg) push_issue "$3" ;;
  esac
  return 0
}

# One bare word of a `gh issue close`, which gh takes as an issue number or a
# URL. A word that is neither — a leftover expansion, a stray path — is dropped.
push_issue() {
  local gi_number
  # A URL names its own repository, so it reaches past the --repo scoping above:
  # another repo's `…/issues/12` would otherwise drop THIS session's claim on the
  # local #12, which it may still be working.
  # This repository is read off the HOST repo root (gr_root, #1), not the
  # working directory and not this script's own location: the hook runs
  # wherever the session's shell happens to be, and in a plugin install this
  # script's own directory is the plugin cache, not the host repo.
  gi_local_issue_word "$(gr_root)" "$1" || return 0
  issues+=("$gi_number")
}

# Called once per command the tool call runs, with the segment as $1 and the
# command's own words — environment assignments already stripped — as $2 onward.
release() {
  shift
  [[ "$(basename "${1:-}")" == "gh" ]] || return 0
  # `gh pr close` shares the number space with issues, so a PR close would
  # otherwise drop the claim on the issue of that number.
  [[ "${2-}" == "issue" && "${3-}" == "close" ]] || return 0

  local -a issues=()
  local scoped=0 issue
  gp_scan_flags "$CLOSE_VALUE_FLAGS" close_arg -- "${@:4}"

  ((scoped)) && return 0

  for issue in ${issues+"${issues[@]}"}; do
    # The loop as a whole is bounded, not each call: three issues at `timeout 5`
    # each would outrun the hook's own 10s budget in self-plugin/hooks/hooks.json and be
    # killed mid-loop. Stopping early releases fewer claims, which is the same
    # fail-open direction as releasing none.
    ((SECONDS < 4)) || break
    # Silent: a releaser that printed would put arbiter prose in front of the
    # session on every close. `|| true` because the arbiter's own refusal — an
    # unreadable store, a claim held by another session — is not this hook's to
    # report, and a refusal leaves the claim standing rather than half-dropped.
    CLAUDE_CODE_SESSION_ID="$session" \
      ${bounded:+timeout 5} "$node_bin" "$here/session-arbiter.js" release-issue "$issue" \
      >/dev/null 2>&1 || true
  done
  return 0
}

gp_walk_commands release

exit 0
