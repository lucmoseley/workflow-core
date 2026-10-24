#!/usr/bin/env bash
# PreToolUse guard: the raw issue-body write (mantahostels#132).
#
# Why: a GitHub issue body is download-whole/edit/upload-whole, so two sessions
# editing one issue means the second silently erases the first — on 4 August 2026
# an entry appended to mantahostels#96 was gone ten minutes later. mantahostels#128 established that
# GitHub offers no conditional write to prevent it: PATCH rejects every
# conditional-request header with HTTP 400, GraphQL `updateIssue` has no version
# field, and `updated_at` bumps on comments and labels at one-second resolution.
# The answer is scripts/issue-body.js (mantahostels#131), which re-fetches after writing and
# re-applies your change onto a rival's body where it was overwritten.
#
# DENY, not warn. The callers are spread across /wayfinder, /implement,
# /card-close and /triage, plus any ad-hoc edit, and with every one of them
# routed through the script there is no legitimate direct use of `gh issue edit
# --body` left at all — mantahostels#103's deny side, which is deny on a structured fact
# where the action has no legitimate use, warn where the hook is inferring.
#
# No WFC_ALLOW_* escape, and none is needed: issue-body.js calls GitHub from
# Node rather than through the Bash tool, so the permitted path never reaches
# this hook.
#
# THE OTHER SPELLINGS
#  - `gh api --method PATCH repos/…/issues/<n>` IS chased — the spelling a
#    session reaches for the moment the flag form is denied. Where the PATCH is
#    aimed at an issue but the guard cannot see its fields — a fully quoted
#    `-f "body=…"`, or `--input` — it WARNS rather than denying, because there it
#    is inferring, not reading (mantahostels#103).
#  - `gh api graphql` carrying an `updateIssue` mutation with a body field IS
#    chased (mantahostels#284), by reading its `query` field back out of the span the parser
#    blanked (gp_literal). Where the guard cannot see that text it WARNS, the
#    same inferring tier as the unreadable PATCH — `-F query=@file`, `--input`,
#    a variable, a command substitution, or an input object passed whole as one
#    variable. Denying every opaque `gh api graphql` would refuse the read-only
#    queries that are routine here.
#  - The graphql deny is judged on the `query=` field's VALUE, concatenated by
#    ga_scan_graphql and scoped by ga_mutation_args (both lib/guard-gh-api.sh),
#    and `body:` counts only between `updateIssue(` and its first
#    `)` — a response selection (`{issue{body}}`, the `{issue{body:bodyHTML}}`
#    alias) reads and runs; whitespace is squashed first; an `input:$var`
#    argument names no field and drops to the warn tier. The deny is
#    deliberately NOT gated on the endpoint being `graphql` — a masked or
#    variable endpoint would otherwise walk past a mutation in plain sight — and
#    a query only partly readable is still denied on what can be seen. THE WARN
#    IS GATED, though: warn_once for an unreadable query sits inside
#    ga_is_graphql_endpoint, so a masked endpoint carrying an unreadable query
#    gets neither deny nor warn and passes in silence.
#    Fuzzed at 215 payloads with `bash` as the oracle, 0 mismatches (mantahostels#284).
#  - RESIDUAL, what still reaches a body: the warn cases above; a wrapper or
#    non-`gh` client; `updateIssue(` inside a string literal in a read-only
#    query; and the founder's own terminal, which no Bash hook binds.
#    check-clobbered-bodies.js covers those after the fact.
#
# LIMITS
#  - It matches the *parsed command form* — a segment whose command word is `gh`,
#    whose subcommand pair is `issue edit`, carrying a body flag — never a
#    substring, so a grep, an echo or a heredoc mentioning `gh issue edit --body`
#    passes. The parser is shared with guard-branch.sh and guard-commit-form.sh,
#    in lib/guard-parse.sh (mantahostels#123).
#  - Scope is the ISSUE body. `gh issue create --body` writes a body that does
#    not exist yet; `gh issue comment` creates a new resource and reads no
#    existing state; `gh pr edit --body` is a different resource with no helper
#    to route to.
#  - It FAILS OPEN, house style (mantahostels#103 §6): a command it cannot parse, a missing
#    jq, or the shared parser itself being unreadable are all allowed through —
#    and all RECORDED (mantahostels#147) via lib/guard-log.sh, for check-guard-errors.js to
#    report under `npm run status`. The unreadable-PATCH case is not one of these: it
#    warns rather than failing open.
#  - A write reached through a wrapper — `xargs gh issue edit`, a shell function,
#    a script — is not seen, because only a segment's own command word is read.
#  - Wired with `if: Bash(gh *)` (mantahostels#2127; best-effort:
#    docs/agents/guard-authoring.md's surface 4, which fails toward running)
#    — not exec'd unless some segment of the
#    command leads with `gh`. NEARLY the same test as this guard's own
#    basename check (:221), which differs on one spelling: `/usr/bin/gh …`
#    passes the basename and matches the anchored form in neither spelling, so
#    a path-spelled call is unjudged (mantahostels#2127).
#    Probed directly at mantahostels#2127: this guard denies a bare `gh` call and is silent
#    on `timeout N gh …` and `env gh …`, so the anchored form drops no call it
#    acts on.
#  - THE RULE IT PRINTS lives in docs/agents/rules/, not here (mantahostels#1649, spec
#    mantahostels#1641): CLAUDE.md keeps a trigger line naming the id, and this guard splices
#    the fragment into its refusal. An unreadable fragment is the ONE fault this
#    guard does not fail open on and does not log — the command is resolved and
#    known bad, only the rule could not be read; it refuses with a pointer to the
#    fragment instead.
#  - It guards the Bash tool, so it binds agent sessions and not the founder's
#    own terminal (mantahostels#109).

set -uo pipefail

# The shared parser (mantahostels#123) and the shared `gh api` reader (mantahostels#511). Resolved from
# this file's own location, because a hook runs with an arbitrary cwd. If either
# cannot be loaded the guard disarms itself rather than blocking every Bash call
# — mantahostels#103 §6's fail-open rule.
#
# The gate is ONE name per library, checked separately so the record names the
# library that failed — never `source`'s own exit status. Why one name is enough
# is on gp_begin in lib/guard-parse.sh (mantahostels#157).
#
# lib/guard-log.sh is sourced FIRST and separately, so the one fault that disarms
# this guard entirely — the parser failing to load — is itself recordable (mantahostels#147).
here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null

# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null

declare -F gp_begin >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-parse.sh did not load — every command allowed unchecked"
  exit 0
}

# shellcheck source=scripts/lib/guard-gh-api.sh
source "$here/lib/guard-gh-api.sh" 2>/dev/null
declare -F ga_scan_api >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-gh-api.sh did not load — every command allowed unchecked"
  exit 0
}

gp_begin '.tool_input.command' command

# The envelope is gp_deny's (mantahostels#138) and the rule is the store's (mantahostels#1649, spec
# mantahostels#1641); only the framing line below is this guard's. @CMD@ is where gp_deny
# splices the offending segment in, unmasked. The heredoc is UNquoted so the
# fragment can be spliced, which is why the framing line carries no backtick.
#
# An unreadable fragment is NOT a fail-open here and is not logged: the command
# is resolved and known bad, only the RULE could not be read, and an unreadable
# fragment is check-guard-registry.js's assertion rather than this guard's.
# The fallback is written inline, not held in a variable as the sibling guards
# do, so its `gp_script_path` fork runs only on a refusal and not on every call.
deny() {
  local reason
  IFS= read -r -d '' reason <<EOF || :
This writes an issue body whole, erasing any parallel session's edit: @CMD@

$(gp_rule_text issue-body-clobber "Every issue-body edit goes through node $(gp_script_path issue-body.js); the rule itself could not be read from docs/agents/rules/issue-body-clobber.txt. Read that file before doing anything else.")
EOF
  gp_deny "$reason" "$1"
}

warning="" # held back in case a later segment denies

# $1 names what the guard could not read, $2 what is still fine to do, $3 the
# segment to quote back.
warn_once() {
  [[ -n "$warning" ]] && return 0
  warning="$1

  $(gp_unmask "$3")

If it writes the body, it writes it whole and erases any parallel session's edit — GitHub offers no conditional write (mantahostels#128), and that is the 4 August 2026 loss on mantahostels#96. Route a body change through the helper instead:
  node $(gp_script_path issue-body.js) append <n> --text \"…\"

$2"
}

# Does this `gh issue edit` carry a body flag? `gh` is pflag, which has no
# prefix abbreviation (`--bod` is "unknown flag"), so the long spellings are
# exact. -b and -F are the shorthands, and both take a value, so in a bundle
# they can only appear before the first value-taking letter.
edits_body() {
  local tok rest ch j saw_ddash=0
  for tok in "$@"; do
    ((saw_ddash)) && continue
    case "$tok" in
      --) saw_ddash=1 ;;
      --body | --body=* | --body-file | --body-file=*) return 0 ;;
      --*) ;;
      -?*)
        rest="${tok#-}"
        j=0
        while ((j < ${#rest})); do
          ch="${rest:j:1}"
          case "$ch" in
            b | F) return 0 ;;
            # gh issue edit's other shorthands, every one of which takes a value:
            # the rest of the bundle is that value, not more flags.
            t | m | R) break ;;
          esac
          ((j++))
        done
        ;;
    esac
  done
  return 1
}

# Read a `gh api` invocation, then pull out the one thing lib/guard-gh-api.sh
# does not: $api_body, set by a visible `body=` field. The flags, the endpoint,
# the field list, $api_opaque and the GraphQL query text all come from that
# library, shared with guard-issue-create-label.sh (mantahostels#511, mantahostels#519).
scan_api() {
  ga_scan_api "$@"
  api_body=0
  local val
  for val in ${api_fields+"${api_fields[@]}"}; do
    # Only the field NAME decides. A masked VALUE — `-f title="New"` — is still
    # visibly not the body, and warning on it fires on the safe case (mantahostels#109).
    case "$val" in body=*) api_body=1 ;; esac
  done
  ga_scan_graphql
}

# Called once per command the tool call runs, with the segment as $1 and the
# command's own words — environment assignments already stripped — as $2 onward.
#
# $warning is deliberately NOT local: the first warn found is held back across
# segments in case a later one denies.
judge() {
  local segment="$1"
  shift
  local hidden args hidden_input=0

  [[ "$(basename "$1")" == "gh" ]] || return 0

  case "${2-}" in
    issue)
      [[ "${3-}" == "edit" ]] || return 0
      edits_body "${@:4}" && deny "$segment"
      ;;
    api)
      scan_api "${@:3}"

      # GraphQL names the write in the query text rather than in a field, and
      # goes out as a POST, so neither test below would see it. `body:` inside
      # updateIssue's own arguments is an input field or a variable declaration,
      # both writes.
      if args="$(ga_mutation_args updateIssue)"; then
        if [[ "$args" == *body:* ]]; then
          deny "$segment"
        elif [[ "$args" == *'input:$'* ]]; then
          # The whole input object arrives as one variable, so the query names
          # no field at all and its value is somewhere this guard cannot read.
          # A variable INSIDE a braced input is different: every field name is
          # still spelled out there, so a body could not hide in one.
          hidden_input=1
        fi
      fi
      if ga_is_graphql_endpoint "$api_endpoint"; then
        ((api_query_hidden || api_opaque || api_input || hidden_input)) || return 0
        warn_once "This posts a GraphQL query the guard cannot read in full:" \
          "A read-only query is fine; carry on." "$segment"
        return 0
      fi

      # A method or an endpoint the parser cannot read is not a pass: it drops
      # the segment to the warn tier below rather than out of the guard.
      if [[ "${api_method^^}" == "PATCH" ]]; then
        hidden=0
      elif [[ "$api_method" == *"$QUOTED"* || "$api_method" == *'$'* ]]; then
        hidden=1
      else
        return 0 # GET, POST, or no method at all: not a body write
      fi
      if ! ga_is_issue_endpoint "$api_endpoint"; then
        [[ "$api_endpoint" == *"$QUOTED"* || "$api_endpoint" == *'$'* ]] || return 0
        hidden=1
      fi

      ((hidden)) || { ((api_body)) && deny "$segment"; }
      ((api_body || api_opaque || api_input)) || return 0
      warn_once "This PATCHes an issue resource directly, and the guard cannot see whether it writes the body:" \
        "A field-only PATCH — state, labels, assignees — is fine; carry on." "$segment"
      ;;
  esac
}

gp_walk_commands judge

[[ -n "$warning" ]] && gp_warn "$warning"

gp_allow
