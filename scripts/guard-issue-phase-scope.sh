#!/usr/bin/env bash
# PreToolUse guard: no issue is created for a roadmap card the founder has not
# called (mantahostels#1613, which built and ruled it).
#
# Why: on 26 August 2026 decision map mantahostels#1489 (`search-core`) opened nine child
# issues in one day, against a Phase-1 card nobody had asked for. It was not
# alone — 33 open issues turned out to be work spun up against Phase-1 cards
# while the project is still validating Phase 0.
#
# The rule: a `gh issue create` whose TITLE begins `<card-id> — ` is denied
# when that card's phase in docs/reference-roadmap.html is not 0 and the card
# has no row in docs/called-cards.md.
#
# DENY, not warn, and this is the distinction mantahostels#103 draws: deny on a structured
# fact, warn where the hook is inferring. The card id is read off the title
# prefix, the phase is read off the roadmap, and the register is a file — three
# facts, no inference. The founder chose the deny explicitly over a warn-only
# report, on the ground that warn-only machinery here is absorbed as noise.
#
# WHY THE TITLE PREFIX AND NOTHING CLEVERER. `<card-id> — <subject>` is this
# repo's title convention for card-derived issues, and every one of the 33
# retired issues that carried a card carried it that way. The BODY is not
# scanned for card ids: a workflow ticket that merely mentions `privacy-ops` in
# passing would be refused, and refusing legitimate machinery work is a worse
# failure than missing an occasional product ticket.
#
# LIMITS
#  - AN ISSUE CARRYING NO CARD PREFIX ESCAPES ENTIRELY, and re-titling to drop
#    the prefix is therefore a one-keystroke bypass. mantahostels#927 (validate the launch
#    catalogue before it publishes) was exactly that shape — Phase-1
#    seed-listings work with a bare title — and would pass. THE PREFIX IS AN
#    HONESTY MARKER, NOT A SYNTAX RULE: nothing here can close that, so the deny
#    text names the bypass and forbids it rather than pretending it does not
#    exist. scripts/check-issue-card-drift.js is the reporting-tier control.
#  - A WRAPPED COMMAND whose wrapper takes arguments of its own — `env FOO=1 gh
#    …`, `timeout --signal=INT 60 gh …`, `xargs gh …`, `sh -c '…'` — is not
#    followed. The no-argument wrappers ARE (is_wrapper), so the common
#    `env gh …` and `timeout 60 gh …` spellings are judged.
#  - It matches the parsed command form, never a substring, so an echo or a
#    heredoc mentioning `gh issue create` passes.
#  - `gh api --method POST …/issues` IS chased, gh's own POST default with it.
#    `gh api graphql` is NOT: a createIssue mutation's title would have to be
#    read out of query text, and the guard would be inferring rather than
#    reading. Documented residual, not an oversight.
#  - A PreToolUse hook sees Bash tool calls only, so AN ISSUE CREATED BY A
#    SCRIPT OR FROM THE WEB UI ESCAPES.
#  - Wired with `if: Bash(*gh *)` (mantahostels#2127; best-effort:
#    docs/agents/guard-authoring.md's surface 4,
#    which fails toward running) — not exec'd unless the command carries `gh `
#    somewhere, quoted spans included.
#  - IT IS DELIBERATELY NOT THE ANCHORED `Bash(gh *)` the other ten carry.
#    This is the only one of the eleven that walks past a no-argument wrapper,
#    so `timeout 60 gh issue create` and `nohup gh issue create` reach judge()
#    here and nowhere else — and the anchored form matches neither, which would
#    leave those two spellings unjudged in silence. Probed both ways at mantahostels#2127:
#    bare, `timeout`-prefixed and `env`-prefixed all deny; `sh -c` is silent.
#  - ANY SESSION WRITES THE REGISTER (mantahostels#3483, reversing mantahostels#1613's founder-only
#    authorship); only the founder CALLS a card. Nothing checks a row against
#    his instruction, and this guard reads the file from disk, so a row need
#    not even be committed.
#  - It FAILS OPEN, house style (mantahostels#103 §6): an unreadable title, an unreadable
#    roadmap, a missing register or a missing jq all allow the creation, and all
#    are RECORDED (mantahostels#147) via lib/guard-log.sh for check-guard-errors.js to
#    report under `npm run status`.
#  - It guards the Bash tool, so it binds agent sessions and not the founder's
#    own terminal (mantahostels#109).

# IMPLICIT:  besides refusing the create, WRITES a fail-open record whenever it cannot read a title, the roadmap or the register — a file this session never asked it to touch.
# JUSTIFIED: fail-safe — a guard that allowed unchecked in silence would report itself as protecting work it never judged, which is what check-guard-errors.js exists to surface (mantahostels#147).
# DEFEAT:    none for the record itself; the deny it guards is escaped by a row in docs/called-cards.md for a card the founder has called, never by a session calling its own.

set -uo pipefail

here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-root.sh
source "$here/lib/guard-root.sh"
# gr_root() finds the HOST repo, never this file's own location — in a plugin
# install this script ships in the plugin cache, not the host repo, so `$here`
# cannot stand in for the root (workflow-core#1).
root="$(gr_root)"

ROADMAP="$root/docs/reference-roadmap.html"
REGISTER="$root/docs/called-cards.md"

# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null

# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null
declare -F gp_begin >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-parse.sh did not load — every issue creation allowed unchecked"
  exit 0
}

# shellcheck source=scripts/lib/guard-gh-api.sh
source "$here/lib/guard-gh-api.sh" 2>/dev/null
declare -F ga_scan_api >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-gh-api.sh did not load — every issue creation allowed unchecked"
  exit 0
}

gp_begin '.tool_input.command' command

# The card id a title names, or empty. The convention is `<card-id> — <subject>`
# with an EM DASH or an EN DASH; a hyphen is not accepted, because card ids
# contain hyphens and `seed-listings - x` cannot be split without guessing where
# the id ends.
#
# The prefix is TRIMMED before it is judged. Without that, `search-core  — x`
# with a doubled space — an ordinary typo — walks past the regex below and the
# whole guard with it.
card_of_title() {
  local title="$1" prefix
  case "$title" in
    *' — '*) prefix="${title%% — *}" ;;
    *' – '*) prefix="${title%% – *}" ;;
    *'—'*) prefix="${title%%—*}" ;;
    *) return 1 ;;
  esac
  prefix="${prefix#"${prefix%%[![:space:]]*}"}"
  prefix="${prefix%"${prefix##*[![:space:]]}"}"
  # A card id is lower-case, digits and hyphens. Anything else — a sentence, a
  # capital, a slash — is prose that happens to contain a dash.
  #
  # THIS REGEX IS ALSO WHAT MAKES $card SAFE to interpolate into the two grep
  # patterns below: it admits no metacharacter, no glob and no leading `-`.
  # Relaxing it arms both call sites — re-check them before you widen it.
  [[ "$prefix" =~ ^[a-z0-9][a-z0-9-]*$ ]] || return 1
  printf '%s' "$prefix"
}

# The phase digit of a card. Prints it and returns 0; returns 1 where the
# roadmap names no such card, which means the prefix was never a card reference.
#
# Returns 2 — distinct, and the caller records it — where grep could not read
# the file at all. Collapsing that into "no such card" is how a roadmap the
# guard cannot parse turns every card into an unknown one and disarms the guard
# in silence. $card is safe here: see card_of_title's regex.
phase_of_card() {
  local card="$1" hit rc
  hit="$(grep -o "id:\"$card\",p:[0-9]" "$ROADMAP" 2>/dev/null)"
  rc=$?
  # grep exits 1 for "no match" and >1 for a real read failure.
  ((rc > 1)) && return 2
  [[ -n "$hit" ]] || return 1
  hit="${hit%%$'\n'*}"
  printf '%s' "${hit##*:}"
}

# Whether the founder has called a card. Only rows BETWEEN the two markers are
# read, so the format example in the register's own prose is not a live row.
card_is_called() {
  local card="$1"
  awk '/called-cards:begin/{f=1;next} /called-cards:end/{f=0} f' "$REGISTER" 2>/dev/null |
    grep -qE "^- \`$card\`"
}

deny_uncalled() {
  local segment="$1" card="$2" phase="$3" reason
  IFS= read -r -d '' reason <<EOF || :
This opens an issue for \`$card\`, a **Phase $phase** roadmap card the founder has not called: @CMD@

The project is still validating Phase 0. On 27 August 2026, 33 issues that had been opened this way — decision map mantahostels#1489 (\`search-core\`) alone spun up nine in a day — were retired back onto their cards, because work was accumulating on a frontier nobody had asked for.

**A card becomes workable when the founder calls it, and only then — then any session adds its row to \`docs/called-cards.md\`. Never add the row to unblock yourself** — a session that can call its own card is under no constraint at all. Ask him, naming the card and what you want to open on it.

**What to do instead: write the question onto the \`$card\` card** in \`docs/reference-roadmap.html\`, through the \`roadmap-edit\` skill, as a parked question to re-file when the card is taken. That is where all 33 went, and it loses nothing.

**Re-titling to get past this guard is the one thing you must not do.** This hook reads the \`$card — \` prefix and nothing else, so removing it files the issue unchallenged — which makes the prefix an honesty marker, not a syntax rule. If you genuinely believe this is repo machinery rather than the adopter's product, business, catalogue or legal decision, that is a judgement the founder gets to check: say so to him in plain words and let him answer, rather than editing the title and proceeding.

Rule: docs/called-cards.md; mantahostels#1613.
EOF
  gp_deny "$reason" "$segment"
}

# Given a title, decide. Shared by both routes.
judge_title() {
  local segment="$1" title="$2" card phase rc
  card="$(card_of_title "$title")" || return 0

  phase="$(phase_of_card "$card")"
  rc=$?
  # 2 is "the roadmap would not read", the one case that must never pass as
  # "no such card" — see phase_of_card.
  ((rc == 2)) && {
    gl_open "docs/reference-roadmap.html would not read — issue creation for $card allowed unchecked"
    return 0
  }
  ((rc)) && return 0
  [[ "$phase" == "0" ]] && return 0

  [[ -r "$REGISTER" ]] || {
    gl_open "docs/called-cards.md is unreadable — issue creation for $card allowed unchecked"
    return 0
  }

  card_is_called "$card" && return 0
  deny_uncalled "$segment" "$card" "$phase"
}

CREATE_VALUE_FLAGS="-t --title -b --body -F --body-file -a --assignee \
-m --milestone -p --project -T --template -R --repo -l --label"

create_arg() {
  case "$2" in
    --help | -h)
      helping=1
      return 1
      ;;
  esac
  case "$1" in
    opt)
      if [[ "$2" == --title || "$2" == -t ]]; then
        title="$(gp_literal "$3")" || {
          title=""
          unreadable="could not read the --title of a gh issue create"
        }
      fi
      ;;
    dangling)
      [[ "$2" == --title || "$2" == -t ]] &&
        unreadable="a gh issue create ends in a --title with no value"
      ;;
    arg) case "$3" in
      *'$'* | *'`'*) unreadable="could not read the arguments of a gh issue create" ;;
    esac ;;
  esac
  return 0
}

judge_create() {
  local segment="$1"
  shift
  local title="" unreadable="" helping=0

  gp_scan_flags "$CREATE_VALUE_FLAGS" create_arg -- "$@"

  ((helping)) && return 0

  # THE TITLE IS JUDGED FIRST, even where some other argument was unreadable.
  # The title is the guard's only input: if it read cleanly and names an
  # uncalled card, that issue gets filed against that card whatever else is on
  # the command, so failing open there would let `--title "search-core — x" $_`
  # walk a deniable creation through on an irrelevant expansion.
  [[ -n "$title" ]] && judge_title "$segment" "$title"

  [[ -n "$unreadable" ]] && {
    gl_open "$unreadable — create allowed unchecked"
    return 0
  }
  return 0
}

# `gh api … repos/<o>/<r>/issues` — the same creation through REST. The method,
# endpoint and fields are read by lib/guard-gh-api.sh, shared with the two other
# gh-facing guards.
judge_api() {
  local segment="$1"
  shift
  local -a api_fields=()
  # ga_scan_api writes into all of these; they must exist as locals, or its
  # assignments escape into the global scope. $api_query and $api_query_hidden
  # carry the GraphQL query text, which this guard deliberately never judges
  # (LIMITS). $api_opaque is NOT a GraphQL signal — lib/guard-gh-api.sh sets it
  # from the REST field scan — and it is read below.
  local api_method="" api_endpoint="" api_opaque=0 api_input=0
  # shellcheck disable=SC2034
  local api_query="" api_query_hidden=0
  local method_hidden=0 endpoint_hidden=0 field text title=""
  local method="" endpoint=""

  ga_scan_api "$@"

  method="$(gp_literal "$api_method")" || method_hidden=1
  endpoint="$(gp_literal "$api_endpoint")" || endpoint_hidden=1

  if ((!method_hidden)); then
    if [[ -z "$method" ]]; then
      ga_defaults_to_post || return 0
    elif [[ "${method^^}" != "POST" ]]; then
      return 0
    fi
  fi

  # GraphQL is a documented residual — see LIMITS.
  if ((!endpoint_hidden)) && ga_is_graphql_endpoint "$endpoint"; then return 0; fi

  ((endpoint_hidden)) || ga_is_issue_collection_endpoint "$endpoint" || return 0

  ((method_hidden || endpoint_hidden || api_input)) && {
    gl_open "could not read a gh api issue creation — create allowed unchecked"
    return 0
  }

  # THE FIELD NAME DECIDES WHETHER THE VALUE MATTERS, so a field whose own NAME
  # is hidden — `-f "$FIELD"` — could be the title and cannot be told from any
  # other. Falling through on one silently allows a creation this guard never
  # judged, which is the failure the fail-open record exists to make visible.
  # $api_opaque is lib/guard-gh-api.sh's own signal that a field word was masked
  # — the exact condition under which a `title=` could be sitting in the part
  # this loop cannot see.
  ((api_opaque)) && {
    gl_open "a gh api issue creation carried a masked field word — create allowed unchecked"
    return 0
  }

  for field in ${api_fields+"${api_fields[@]}"}; do
    text="$(gp_literal "$field")"
    case "${text%%=*}" in
      *'$'* | *'`'*)
        gl_open "could not read a field name on a gh api issue creation — create allowed unchecked"
        return 0
        ;;
    esac
    case "$text" in
      title=*)
        title="${text#title=}"
        # The name read but the VALUE did not, so the card cannot be known.
        [[ "$title" == *'$'* || "$title" == *'`'* ]] && {
          gl_open "could not read the title field on a gh api issue creation — create allowed unchecked"
          return 0
        }
        ;;
    esac
  done

  [[ -n "$title" ]] && judge_title "$segment" "$title"
  return 0
}

# Wrappers that run their argument as a command. `env gh issue create …` and
# `timeout 60 gh issue create …` are ordinary spellings, and without this the
# whole guard is escaped by prefixing one word. Only the no-argument forms are
# skipped: `env FOO=1 gh …` and `timeout --signal=X …` stop the walk, which
# leaves the create unjudged rather than misjudged, and LIMITS says so.
is_wrapper() {
  case "$1" in
    env | command | exec | nohup | nice | timeout | stdbuf | setsid) return 0 ;;
  esac
  return 1
}

judge() {
  local segment="$1"
  shift

  while (($#)) && is_wrapper "$(basename "$1")"; do
    local was
    was="$(basename "$1")"
    shift
    # `timeout` and `nice` take one leading value of their own — a duration and
    # an adjustment. Skipping it is what makes `timeout 60 gh issue create …`
    # reach the judge rather than stopping the walk on the digits.
    if [[ "$was" == timeout && "${1-}" =~ ^[0-9]+([.][0-9]+)?[smhd]?$ ]]; then
      shift
    elif [[ "$was" == nice && "${1-}" =~ ^-n$ ]]; then
      shift 2
    fi
  done
  (($#)) || return 0

  [[ "$(basename "$1")" == "gh" ]] || return 0

  case "${2-}" in
    issue)
      [[ "${3-}" == "create" ]] || return 0
      ;;
    api) ;;
    *) return 0 ;;
  esac

  # The roadmap is what says a card's phase, and a guard that cannot read its
  # own authority allows the work. Checked HERE, after the command is known to
  # be a creation: in judge()'s preamble it fired on every `gh` call this repo
  # makes — `gh issue list`, `gh pr view` — and buried the session-start
  # fail-open report under records for commands it was never asked to judge.
  [[ -r "$ROADMAP" ]] || {
    gl_open "docs/reference-roadmap.html is unreadable — issue creation allowed unchecked"
    return 0
  }

  case "${2-}" in
    issue) judge_create "$segment" "${@:4}" ;;
    api) judge_api "$segment" "${@:3}" ;;
  esac
}

gp_walk_commands judge

gp_allow
