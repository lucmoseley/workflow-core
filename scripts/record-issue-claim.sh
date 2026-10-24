#!/usr/bin/env bash
# PostToolUse recorder on Bash: when a session assigns itself to an issue, record
# that claim in the session arbiter (mantahostels#646, the build; mantahostels#645, which added the
# claim-issue store; mantahostels#633, which ruled the option this is the second half of).
#
# WHY A HOOK AND NOT A RULE. docs/agents/issue-tracker.md already tells a session
# to run `node scripts/session-arbiter.js claim-issue <n>` alongside its
# `--add-assignee @me`; left as prose that is a second thing to remember. The
# claim has one identifiable moment — `gh issue edit <n> --add-assignee @me`, the
# working session's first write on the issue it takes — so a hook can read it.
#
# WHY THE ASSIGNEE ALONE IS NOT THE CLAIM. It survives the session that set it,
# so a dead session's assignee hid its issue from /pick-next's frontier for good
# (mantahostels#633). The arbiter record carries the session id, which liveness can be tested
# against.
#
# IT ONLY EVER RECORDS. Nothing is refused, nothing is injected, and every
# failure path exits 0 in silence. A claim that fails to write leaves the issue
# selectable.
#
# LIMITS
#  - A PostToolUse hook sees Bash tool calls only, so AN ASSIGNMENT MADE FROM THE
#    GITHUB WEB UI, BY A SCRIPT, OR THROUGH `gh api` RECORDS NOTHING. That fails
#    open — the issue stays selectable.
#  - `gh issue create --assignee @me` RECORDS NOTHING, and that one cannot be
#    fixed here: the number the issue gets is in gh's output, not in the command.
#    /to-spec assigns on creation, so a session on that route still runs
#    `claim-issue <n>` itself.
#  - `@me` only. An assignment spelled with the account's own login records
#    nothing, the hook having no way to know whose login is running it without
#    asking GitHub, which is a network call on every Bash command.
#  - A `--repo`-qualified edit records nothing: the arbiter's claim store is
#    per-repository, so a number from another repository would be filed under
#    this one. That holds EVEN WHERE --repo NAMES THIS REPOSITORY, unlike an
#    issue URL, which is matched against the origin remote.
#  - AN ISSUE NUMBER ARRIVING AS A SHELL VARIABLE OR A COMMAND SUBSTITUTION
#    RECORDS NOTHING — `n=123; gh issue edit "$n" --add-assignee @me`. This reads
#    the command text and never a shell that could expand it, so the number is
#    never there to find. Confirmed by driving the hook at mantahostels#731.
#  - It runs AFTER the command, and reads the command rather than its result, so
#    an assignment that failed still records a claim. It expires with the session
#    either way, and claiming an issue this session was working is the safe
#    direction of that error.
#  - Wired with `if: Bash(gh *)` (mantahostels#2127; best-effort:
#    docs/agents/guard-authoring.md's surface 4,
#    which fails toward running) — not exec'd unless some segment of the
#    command leads with `gh`. NEARLY the same test as `record()`'s own
#    basename check (:169), which differs on one spelling: `/usr/bin/gh …`
#    passes the basename and matches the anchored form in neither spelling, so
#    a path-spelled call is unjudged (mantahostels#2127).
#    Read rather than probed (mantahostels#2127): `record()` gates on the command word alone with
#    no wrapper walk, so the anchored form drops no call it acts on.
#
# IMPLICIT:  after a `gh issue edit <n> --add-assignee @me`, records that issue claim in the session arbiter without the session asking.
# JUSTIFIED: convenience — the rule it automates is written down and still spellable by hand (`session-arbiter.js claim-issue <n>`); left as prose it was a second thing to remember.
# DEFEAT:    evadable by spelling — `--repo`, a shell variable, `gh api` or the web UI all miss the seam — but there is no switch.

set -uo pipefail

# Injected at its §N7 var, never by PATH, because the tests feed it a chosen
# exit code per case (#2266).
node_bin="${WFC_NODE:-node}"

# lib/guard-log.sh is sourced FIRST and separately, so the one fault that
# disarms this recorder entirely — the parser failing to load — is itself
# recordable (mantahostels#147). The gate is ONE name, `gp_begin` — never `source`'s own
# exit status. Why that is enough is on gp_begin in lib/guard-parse.sh (mantahostels#157).
here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null

# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null
declare -F gp_begin >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-parse.sh did not load — no issue claim recorded"
  exit 0
}

# shellcheck source=scripts/lib/guard-root.sh
source "$here/lib/guard-root.sh"

# shellcheck source=scripts/lib/gh-issue-ref.sh
source "$here/lib/gh-issue-ref.sh" 2>/dev/null
declare -F gi_issue_word >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/gh-issue-ref.sh did not load — no issue claim recorded"
  exit 0
}

gp_begin '.tool_input.command' command

# The matcher in self-plugin/hooks/hooks.json already scopes this to Bash; the test
# drives the hook directly, and a payload from any other tool carries a command
# field that means something else.
[[ "$(gp_payload_field '.tool_name // "Bash"')" == "Bash" ]] || exit 0

# The claim is recorded against the session that made it, and the arbiter takes
# that from the environment rather than from argv — deliberately, so no caller
# can record or drop a claim under somebody else's name (session-arbiter.js,
# `case "claim-issue"`).
session="$(gp_payload_field '.session_id // ""')"
[[ -n "$session" ]] || session="${CLAUDE_CODE_SESSION_ID:-}"
[[ -n "$session" ]] || exit 0

# Recorded, not silent: with node gone this hook records nothing for as long as
# that lasts (mantahostels#147).
command -v "$node_bin" >/dev/null 2>&1 ||
  gl_open "node not found — no issue claim recorded"

# `timeout` is what keeps a wedged arbiter inside the hook's budget, but it is
# not worth abandoning the record when the binary is missing — refresh-claims.sh
# makes the same call for the same reason.
bounded=""
command -v timeout >/dev/null 2>&1 && bounded=1

# The flags `gh issue edit` takes a value for, short and long together. Leave one
# out and its value is read as a bare word — `--title 646` would then be recorded
# as an issue claim.
EDIT_VALUE_FLAGS="--add-assignee --remove-assignee --add-label --remove-label \
--add-project --remove-project --add-sub-issue --remove-sub-issue \
--add-blocked-by --remove-blocked-by --add-blocking --remove-blocking \
--parent --type -m --milestone -t --title -b --body -F --body-file -R --repo"

# One argument of a `gh issue edit`, as <kind> <name> <value>. Sets $assigns_me,
# $scoped and appends to $issues.
edit_arg() {
  case "$1" in
    opt)
      case "$2" in
        # gh takes a comma-separated list of logins, so `@me` may be one of
        # several — the session is still assigning itself.
        --add-assignee)
          case ",$(gp_literal "$3")," in *,@me,*) assigns_me=1 ;; esac
          ;;
        -R | --repo) scoped=1 ;;
      esac
      ;;
    # `dangling` is a value-taking flag with no value left to take, and is the
    # only other kind --repo can arrive as, being in the spec above.
    dangling) [[ "$2" == -R || "$2" == --repo ]] && scoped=1 ;;
    arg) push_issue "$3" ;;
  esac
  return 0
}

# One bare word of a `gh issue edit`, which gh takes as an issue number or a URL.
# A word that is neither — a leftover expansion, a stray path — is dropped.
push_issue() {
  local gi_number
  # A URL names its own repository, so it reaches past the --repo scoping above:
  # `…/someone/elsewhere/issues/12` would otherwise file a claim on THIS repo's
  # #12 and hide a takeable issue from /pick-next. Anything but this repository's
  # own URL is dropped.
  # This repository is read off the HOST repo root (gr_root, #1), not the
  # working directory and not this script's own location: the hook runs
  # wherever the session's shell happens to be, and in a plugin install this
  # script's own directory is the plugin cache, not the host repo.
  gi_local_issue_word "$(gr_root)" "$1" || return 0
  issues+=("$gi_number")
}

# Called once per command the tool call runs, with the segment as $1 and the
# command's own words — environment assignments already stripped — as $2 onward.
record() {
  shift
  [[ "$(basename "${1:-}")" == "gh" ]] || return 0
  [[ "${2-}" == "issue" && "${3-}" == "edit" ]] || return 0

  local -a issues=()
  local assigns_me=0 scoped=0 issue
  gp_scan_flags "$EDIT_VALUE_FLAGS" edit_arg -- "${@:4}"

  ((assigns_me)) || return 0
  ((scoped)) && return 0

  for issue in ${issues+"${issues[@]}"}; do
    # The loop as a whole is bounded, not each call: three issues at `timeout 5`
    # each would outrun the hook's own 10s budget in self-plugin/hooks/hooks.json and be
    # killed mid-loop. Stopping early records fewer claims, which is the same
    # fail-open direction as recording none.
    ((SECONDS < 4)) || break
    # Silent: a recorder that printed would put arbiter prose in front of the
    # session on every self-assignment. `|| true` because the
    # arbiter's own refusal — an unwritable store, a number it rejects — is not
    # this hook's to report.
    CLAUDE_CODE_SESSION_ID="$session" \
      ${bounded:+timeout 5} "$node_bin" "$here/session-arbiter.js" claim-issue "$issue" \
      >/dev/null 2>&1 || true
  done
  return 0
}

gp_walk_commands record

exit 0
