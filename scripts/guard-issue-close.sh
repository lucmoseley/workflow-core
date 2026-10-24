#!/usr/bin/env bash
# PreToolUse guard: a close must say what is still outstanding (mantahostels#185), must
# not close a roadmap card's issue while the card is still not done (mantahostels#220),
# must not complete an issue over unmet acceptance criteria (workflow-core#1640), and must
# not complete one over census rows its commits expired (workflow-core#1913).
#
# Why: a closed issue is corpus, not a queue — nothing surfaces it again — so
# residual work parked in one is found only when the founder happens to read
# the comment.
#
# The rule this enforces: every close carries a line beginning `**Outstanding:**`
# — in the close's own --comment, or else the issue's newest comment; an older
# marker does not count (workflow-core#984). It holds the bare word `none`, or items only,
# each `#N (what is left)` citing an OPEN issue other than this one.
#
# THE SECOND RULE (mantahostels#220): a roadmap card's own issue is closed by /card-close,
# never by hand. Closing it by hand does not merely skip a step — /card-close
# step 1 refuses to run on an issue that is already CLOSED, so a hand close
# makes the command unusable and the roadmap edit has to happen outside the one
# thing that sequences it (mantahostels#165).
#
# The discriminator, settled at mantahostels#275: a child ticket that merely shares a
# card-id prefix has a parent, a card's own issue has none. Measured there —
# 33 of 39 prefixed closed issues had a parent and were all children; all 5 card
# issues had none. A `wayfinder:*` label was measured and rejected as *the*
# discriminator: it separates only 26 of the 33, the doc-map-nav-check children
# carrying `kind:ticket` instead.
#
# ON TOP of it, a `wayfinder:map` label exempts (mantahostels#1490). A map is unparented
# like a card's own issue, so every card-prefixed map read as one and would be
# denied at its close. The exemption survives mantahostels#275's measurement
# because it does a different job: the rejected version had to catch every
# CHILD, and a label missed 7 of 33; this one only has to be true of maps, and
# a map is never a card's own issue.
#
# Known residual: an unparented issue that borrows a card's prefix, carries no
# `wayfinder:map` label, and is neither that card's issue nor a map, is
# indistinguishable from the real thing and would be denied wrongly. The escape
# is the same --reason "not planned" the first rule already honours, or
# /card-close itself.
#
# THE THIRD RULE (workflow-core#1640): a completed close of an issue with unticked,
# unwaived acceptance criteria is denied, whatever its labels — the same
# refusal resolve-ticket.js makes, read through lib/ticket-criteria.js.
#
# THE FOURTH RULE (workflow-core#1913): a completed close is denied where commits citing
# the issue changed what an instruction-surface census row measured and HEAD
# has not re-anchored it, unless a `**Census:**` line in the close's --comment,
# or else the newest comment, says why — resolve-ticket.js's refusal (workflow-core#1876),
# read through lib/census-digest.js. A close naming another repo owes none:
# the commits cite this one's tracker.
#
# DENY, not warn, and this is the distinction mantahostels#103 draws: deny on a structured
# fact, warn where the hook is inferring. Whether a comment's prose describes
# unfiled work is inference, and no detector is built on it
# (mantahostels#185; examples on workflow-core#1990): an accepted limit and a real escape
# are written identically, so the prose around the line stays unread. The
# LINE is a structured fact (workflow-core#984, spec workflow-core#958): lib/outstanding-line.js reads
# its grammar and checks each cited carrier open, and a shape miss or a
# closed, missing or self-referencing carrier is denied.
#
# LIMITS
#  - It matches the parsed command form — a segment whose command word is `gh`,
#    subcommand pair `issue close` — never a substring, so a grep or a heredoc
#    mentioning `gh issue close` passes.
#  - A close through the GitHub UI, or through `gh api --method PATCH … -f
#    state=closed`, is not seen. The UI cannot be reached from here at all; the
#    api spelling is the known residual, left alone because guard-issue-body.sh
#    already carries the PATCH-shaped machinery and duplicating it here would
#    put two readers on one endpoint.
#  - It FAILS OPEN, house style (mantahostels#103 §6): an unparseable command, a missing jq,
#    a missing or unreachable `gh`, an unreadable shared parser, a --comment
#    it cannot wholly read, an Outstanding-line parser that crashed or
#    printed no verdict, a criteria reader that printed none, a census reader
#    that printed none or ran out of budget, and an open-check
#    the Outstanding-line parser could not make are all allowed through — and all RECORDED (mantahostels#147) via lib/guard-log.sh, for
#    check-guard-errors.js to report under `npm run status`.
#  - THE RULE IT PRINTS lives in docs/agents/rules/, not here (mantahostels#1649, spec
#    mantahostels#1641): CLAUDE.md keeps a trigger line naming the id, and this guard splices
#    the fragment into its refusal. An unreadable fragment is the ONE fault this
#    guard does not fail open on and does not log — the command is resolved and
#    known bad, only the rule could not be read; it refuses with a pointer to the
#    fragment instead.
#  - Wired with `if: Bash(gh *)` (mantahostels#2127; best-effort:
#    docs/agents/guard-authoring.md's surface 4, which fails toward running) —
#    not exec'd unless some segment of the command leads with `gh`. NEARLY the
#    same test as judge()'s own basename check, which differs on one spelling:
#    `/usr/bin/gh …` passes the basename and does not match the anchored
#    form, so a path-spelled call is unjudged.
#  - It guards the Bash tool, so it binds agent sessions and not the founder's
#    own terminal (mantahostels#109).
#  - A `-R`/`--repo` close is judged against the repo it names (workflow-core#553), and the
#    card rule stands down where that is not the tracker `.claude/workflow-core.json`
#    declares, or the origin remote's where it declares none: this roadmap's
#    cards, and /card-close, belong to that tracker. No tracker resolving leaves
#    the card rule running. A
#    `GH_REPO=… gh issue close N` is not seen: the parser strips the
#    assignment, so that close is still read off this repo's #N.
#  - A --comment it cannot wholly read — a `$` or backtick expansion, say — is
#    not judged at all: the close is allowed and recorded, its marker unseen.
#  - A chained `gh issue comment N … && gh issue close N` is judged before the
#    comment lands: the close carries its own line, or runs in a later call.

set -uo pipefail

# The issue payload, cached for the last repo#number fetched and shared by all
# three rules.
# issue_fetched is the repo#number it belongs to: one tool call can close two
# issues, and judge() runs per segment in one process, so a cache without its
# key answers the second close from the first one's payload.
issue_json=""
issue_fetched=""
repo=""
repo_hidden=0
card_id=""
card_state=""
card_fault=""

# lib/guard-log.sh is sourced FIRST and separately, so the one fault that
# disarms this guard entirely — the parser failing to load — is itself
# recordable (mantahostels#147). The gate is ONE name, `gp_begin` — never `source`'s own exit
# status. Why that is enough is on gp_begin in lib/guard-parse.sh (mantahostels#157).
here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null

# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null
declare -F gp_begin >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-parse.sh did not load — every issue close allowed unchecked"
  exit 0
}

gp_begin '.tool_input.command' command

# Read a `gh issue close` invocation. Sets $issue (the number), $has_reason,
# $reason — the last --reason value, with $reason_hidden where it could not be
# read — and $repo — the `-R`/`--repo` value, empty where none — with $repo_hidden
# where that value could not be read, and $comment — the last --comment, as gh
# takes it — with $comment_hidden where some of it could not be read.
#
# The shared reader is told which flags take a value (mantahostels#477). Without that skip,
# `gh issue close --comment "…" 12` reads the masked comment as the issue
# number, the lookup below fails, and the guard logs a fail-open on a command it
# could have judged.
scan_close() {
  issue=""
  has_reason=0
  reason=""
  reason_hidden=0
  repo=""
  repo_hidden=0
  comment=""
  comment_hidden=0
  gp_scan_flags "-c --comment -R --repo -r --reason" close_arg -- "$@"
  return 0
}

# One argument of that invocation, as <kind> <name> <value>. A --reason with no
# value left to take still counts as spelled, its value unread.
close_arg() {
  case "$1" in
    opt | dangling)
      if [[ "$2" == -r || "$2" == --reason ]]; then
        has_reason=1
        reason_hidden=0
        if [[ "$1" == opt ]]; then
          reason="$(gp_literal "$3")" || reason_hidden=1
        else
          reason_hidden=1
        fi
      fi
      if [[ "$1" == opt && ("$2" == -R || "$2" == --repo) ]]; then
        repo="$(gp_literal "$3")" || repo_hidden=1
      fi
      if [[ "$1" == opt && ("$2" == -c || "$2" == --comment) ]]; then
        comment_hidden=0
        comment="$(gp_literal "$3")" || comment_hidden=1
      fi
      ;;
    arg)
      [[ -n "$issue" ]] && return 0
      # The parser blanked a quoted number, and `gh issue close "#12"` closes workflow-core#12,
      # so the span is read back (workflow-core#547). A `"$ISSUE"` reads back unexpanded and
      # fails open below. `\#12` reaches gh as `#12` too, bash dropping the `\`.
      issue="$(gp_literal "$3")" || :
      issue="${issue#\\}"
      issue="${issue#\#}"
      ;;
  esac
  return 0
}

# THE TIME BUDGET (docs/agents/guard-authoring.md §The ceiling your guard runs
# under). The hook is cancelled at 10 s (self-plugin/hooks/hooks.json), and a
# cancelled hook allows with its record lost. Each close costs up to five
# external calls — the issue read, the criteria and census readers and the
# Outstanding-line parser's two — so each call gets
# what is left of an 8 s run budget, at most 4 s. $SECONDS counts whole
# seconds, so a call can start up to 1 s later than it reads: the last one ends
# by 9 s, however many closes one command holds, and a call with under 1 s
# left is not made but recorded as a fail-open.
BUDGET_S=8
call_budget() {
  local left=$((BUDGET_S - SECONDS))
  ((left > 4)) && left=4
  printf '%s' "$left"
}

# The `gh` binary, injected at WFC_GH (base §N7);
# lib/outstanding-line.js reads the same var through lib/gh.js.
gh_bin="${WFC_GH:-gh}"

# Injected at their §N7 vars, never by PATH, because a test feeds them chosen
# output (workflow-core#2266, workflow-core#2422).
node_bin="${WFC_NODE:-node}"
timeout_bin="${WFC_TIMEOUT:-timeout}"

# The issue as GitHub describes it, into $issue_json, re-fetched only when the
# repo#number differs from the last one fetched.
# Returns 2 — not 1 — when GitHub could not be asked, which is a fail-open the
# caller records rather than a confident answer.
#
# ONE request serves all three rules: `title`, `parent` and `body` ride the
# comments' endpoint, so the card and criteria checks cost no extra call.
fetch_issue() {
  local key="$repo#$1" left
  [[ -n "$issue_json" && "$issue_fetched" == "$key" ]] && return 0
  issue_json=""
  issue_fetched=""
  command -v "$gh_bin" >/dev/null 2>&1 || return 2
  left="$(call_budget)"
  ((left >= 1)) || return 2
  issue_json="$("$timeout_bin" "$left" "$gh_bin" issue view "$1" --json comments,title,parent,labels,body \
    ${repo:+--repo "$repo"} 2>/dev/null)" || return 2
  [[ -n "$issue_json" ]] || return 2
  issue_fetched="$key"
}

# Does this close name a repo other than the tracker, declared or derived from
# the origin remote? Non-zero where it names none, names the tracker, or no
# tracker resolves.
elsewhere_repo() {
  local tracker
  [[ -n "$repo" ]] || return 1
  if ! declare -F wfc_tracker >/dev/null 2>&1; then
    gl_log "wfc-config.sh not loaded, so no tracker read — the card and census rules run on $repo"
    return 1
  fi
  tracker="$(wfc_tracker)" || return 1
  [[ -n "$tracker" ]] || return 1
  [[ "$(wfc_repo_slug "$repo")" != "$(wfc_repo_slug "$tracker")" ]]
}

# One field out of the fetched payload, empty when jq cannot answer.
issue_field() {
  printf '%s' "$issue_json" | jq -r "$1" 2>/dev/null
}

# Is this issue a roadmap card's own issue whose card is not yet `done`?
#
# Returns 0 only when the answer is yes, setting $card_id and $card_state. Every
# other outcome returns non-zero, and the ones that mean "could not tell" — as
# opposed to "no" — set $card_fault for the caller to record.
#
# A title that does not parse is NOT one of those: most issues here are not
# cards, so an absent `<card-id> — ` prefix is the ordinary case and means no.
card_not_done() {
  local title parent labels window roadmap count
  card_id=""
  card_state=""
  card_fault=""

  # No fault set: has_marker_on_issue fetches the same payload and records the
  # outage itself, and one unreachable GitHub should leave one line in the log.
  fetch_issue "$1" || return 1

  title="$(issue_field '.title // ""')"
  # `<card-id> — <title>`, em dash, the convention /card-close step 2 parses.
  #
  # DELIBERATELY STRICTER than check-issue-card-drift.js, which takes
  # [A-Za-z0-9._-] and an en dash or hyphen too: this one denies, so a title it
  # misreads blocks sanctioned work. The looser shape is recorded instead
  # (mantahostels#220), and a hit means the convention has drifted and this
  # regex needs widening.
  # Widen isCardOwnIssue in lib/tracker-ops.js with it: resolve-ticket's copy.
  [[ "$title" =~ ^([a-z0-9][a-z0-9-]*)$' — ' ]] || {
    [[ "$title" =~ ^[[:space:]]*[A-Za-z0-9._-]+[[:space:]]+[—–-][[:space:]] ]] &&
      card_fault="title \"${title:0:40}\" looks like a card id this guard will not parse, so it"
    return 1
  }
  card_id="${BASH_REMATCH[1]}"

  # A parent means a child ticket that merely inherited the prefix (mantahostels#275).
  parent="$(issue_field '.parent.number // ""')"
  [[ -n "$parent" ]] && return 1

  # A map borrows the prefix without being the card's issue, and is unparented
  # too, so the test above cannot tell it apart (mantahostels#1490).
  labels="$(issue_field '[.labels[]?.name] | join(" ")')"
  [[ " $labels " == *" wayfinder:map "* ]] && return 1

  # gr_root, not `${CLAUDE_PROJECT_DIR:-$PWD}` — that spelling has no git limb,
  # so with the variable unset and the cwd a subdirectory it named a roadmap
  # that does not exist and this guard silently stopped judging card closes
  # (mantahostels#1905, which folded the tier's copies into one).
  roadmap="$(gr_root)/docs/reference-roadmap.html"
  [[ -r "$roadmap" ]] || {
    card_fault="could not read the roadmap, so card $card_id"
    return 1
  }

  # Exactly one card, or we cannot say which card this is — /card-close step 2
  # stops on the same test rather than guessing.
  #
  # grep -o | wc -l, not grep -c, which counts matching LINES: the roadmap keeps
  # one card per line today, so the two agree, but a reformatting that joined
  # cards would make two cards sharing an id count as one.
  count="$(grep -o "id:\"$card_id\"," "$roadmap" 2>/dev/null | wc -l)" || count=0
  ((count == 1)) || {
    card_fault="$card_id names $count cards on the roadmap, so it"
    return 1
  }

  # Fields run id,p,a,kind,state — state lands within ~90 characters of the id,
  # so a 200-character window reaches it and stops well short of the next card.
  window="$(grep -o "id:\"$card_id\",.\{0,200\}" "$roadmap" 2>/dev/null)"
  card_state="$(printf '%s' "$window" | grep -o 'state:"[a-z]*"' | head -1)"
  card_state="${card_state#state:\"}"
  card_state="${card_state%\"}"
  [[ -n "$card_state" ]] || {
    card_fault="card $card_id has no readable state, so it"
    return 1
  }
  [[ "$card_state" == "done" ]] && return 1
  return 0
}

# The three rules this guard prints (mantahostels#1649, spec mantahostels#1641; workflow-core#1640). Operative
# text in docs/agents/rules/card-close-by-hand.txt, close-outstanding.txt and
# ticket-criteria-unticked.txt; CLAUDE.md keeps a trigger line for the first
# two, so these refusals are where the rules reach a session. One id per rule —
# the id names the trap, not the guard.
OUTSTANDING_RULE_FALLBACK="Every close says what is still outstanding, on a line beginning **Outstanding:**. The rule itself could not be read from docs/agents/rules/close-outstanding.txt. Read that file before doing anything else."

CARD_RULE_FALLBACK="A roadmap card's own issue is closed by /card-close, never by hand. The rule itself could not be read from docs/agents/rules/card-close-by-hand.txt. Read that file before doing anything else."

deny_card() {
  local reason
  IFS= read -r -d '' reason <<EOF || :
This closes the issue for roadmap card \`$2\`, and that card is still \`$3\`, not \`done\`: @CMD@

Close it with **/card-close $4** instead.

$(gp_rule_text card-close-by-hand "$CARD_RULE_FALLBACK")
EOF
  gp_deny "$reason" "$1"
}

# $1 the segment, $2 which comment was read, $3 the parser's JSON verdict.
deny() {
  local reason
  IFS= read -r -d '' reason <<EOF || :
This close does not say what is still outstanding in the form this guard reads: @CMD@

Read: $2.
$(printf '%s' "$3" | jq -r '.message // empty' 2>/dev/null)

$(gp_rule_text close-outstanding "$OUTSTANDING_RULE_FALLBACK")

In one call, with the comment checked before anything is written: node $(gp_script_path resolve-ticket.js) <n> --comment-file <file>. It refuses a comment without a passing **Outstanding:** line, a **Bound:** line, a **Values:** line (**Values:** none where nothing is house or untraced) or a **Practice:** line, and one naming a commit sha without a **Door:** line.
EOF
  gp_deny "$reason" "$1"
}

CRITERIA_RULE_FALLBACK="Tick each acceptance criterion this session verified, or annotate it **waived:** <why>, before closing. The rule itself could not be read from docs/agents/rules/ticket-criteria-unticked.txt. Read that file before doing anything else."

# $1 the segment, $2 the issue number, $3 the unmet criteria, one per line.
deny_criteria() {
  local reason
  IFS= read -r -d '' reason <<EOF || :
This closes #$2 over acceptance criteria neither ticked nor waived: @CMD@

$(printf '%s\n' "$3" | sed 's/^/  - [ ] /')

Re-run the close once each is ticked or waived — or, abandoning the issue, with --reason "not planned".

$(gp_rule_text ticket-criteria-unticked "$CRITERIA_RULE_FALLBACK")
EOF
  gp_deny "$reason" "$1"
}

# Denies, records a fail-open, or returns 0 on a pass (workflow-core#1640). Logged and
# returned rather than gl_open's exit, so the Outstanding rule still runs. An
# unread issue returns 2, unlogged, for judge() to record.
judge_criteria() {
  local segment="$1" n="$2" body left answer unmet
  local heading=$'(^|\n)[[:space:]]{0,3}#+[[:space:]]+acceptance'
  fetch_issue "$n" || return 2
  body="$(issue_field '.body // ""')"
  # Spares a node start on the common body with no criteria heading at all.
  [[ "${body,,}" =~ $heading ]] || return 0
  left="$(call_budget)"
  if ((left < 1)); then
    gl_log "no time left in the guard's budget to read $repo#$n's acceptance criteria — unchecked"
    return 0
  fi
  answer="$(printf '%s' "$body" | "$timeout_bin" "$left" "$node_bin" "$here/lib/ticket-criteria.js" unmet 2>/dev/null)"
  # jq passes empty input silently, so a reader that printed nothing is caught
  # before it.
  if [[ -z "$answer" ]] ||
    ! unmet="$(printf '%s' "$answer" | jq -r '.unmet | if type == "array" then .[] else error end' 2>/dev/null)"; then
    gl_log "the criteria reader gave no verdict on $repo#$n — acceptance criteria unchecked"
    return 0
  fi
  [[ -n "$unmet" ]] && deny_criteria "$segment" "$n" "$unmet"
  return 0
}

# $1 the segment, $2 the census reader's refusal.
deny_census() {
  local reason
  IFS= read -r -d '' reason <<EOF || :
This close leaves census rows its commits expired: @CMD@

$2 The close's own --comment, or else the issue's newest comment, carries it.

Re-run the close once each row is re-anchored or the line is written — or, abandoning the issue, with --reason "not planned".
EOF
  gp_deny "$reason" "$1"
}

# Denies, records a fail-open, or returns 0 on a pass (workflow-core#1913). Logged and
# returned rather than gl_open's exit, so the criteria outage below is still
# recorded.
judge_census() {
  local segment="$1" n="$2" left answer refusal newest="" unread=0
  # The Outstanding rule records an unreadable --comment for the whole close.
  ((comment_hidden)) && return 0
  elsewhere_repo && return 0
  if fetch_issue "$n"; then
    newest="$(issue_field '.comments[-1].body // ""')"
  else
    unread=1
  fi
  left="$(call_budget)"
  if ((left < 1)); then
    gl_log "no time left in the guard's budget to read $repo#$n's census rows — unchecked"
    return 0
  fi
  answer="$(printf '%s\n\n%s' "$comment" "$newest" |
    "$timeout_bin" "$left" "$node_bin" "$here/lib/census-digest.js" expired "$n" 2>/dev/null)"
  if (($? == 124)); then
    gl_log "the census reader ran out of the guard's time budget on $repo#$n — census rows unchecked"
    return 0
  fi
  # jq -e exits non-zero where .refusal is no string, empty input included.
  if ! refusal="$(printf '%s' "$answer" | jq -er '.refusal | strings' 2>/dev/null)"; then
    gl_log "the census reader gave no verdict on $repo#$n — census rows unchecked"
    return 0
  fi
  [[ -n "$refusal" ]] || return 0
  if ((unread)); then
    gl_log "could not read $repo#$n's newest comment for a Census line — census rows unchecked"
    return 0
  fi
  deny_census "$segment" "$refusal"
}

# Whether the close's --comment carries a live **Outstanding:** line, as the
# parser decides, so one quoted in a fence leaves the newest comment to judge
# (workflow-core#1247). The pattern only spares a node start where the marker is absent
# altogether. Returns 0 yes, 1 no, 2 where the parser could not answer — read
# off its output, since node exits 1 on a crash as well (workflow-core#1255).
comment_line_state() {
  local left answer
  [[ $'\n'"$comment" =~ $'\n'[[:blank:]]*'**Outstanding:**' ]] || return 1
  left="$(call_budget)"
  ((left >= 1)) || return 2
  answer="$(printf '%s' "$comment" | "$timeout_bin" "$left" "$node_bin" "$here/lib/outstanding-line.js" has-line 2>/dev/null)"
  case "$answer" in
    yes) return 0 ;;
    no) return 1 ;;
    *) return 2 ;;
  esac
}

# Denies, records a fail-open, or returns 0 on a pass (workflow-core#984).
judge_outstanding() {
  local segment="$1" n="$2" text from verdict rc line left has
  local -a tracker=()
  # An unreadable --comment may carry the line, so the newest comment is no
  # stand-in for it (workflow-core#990, the wrong refusal of workflow-core#1082's close). Logged and
  # returned, not gl_open's exit, so a later close in the same call is judged.
  if ((comment_hidden)); then
    gl_log "could not read the --comment of a gh issue close on $repo#$n — close allowed unchecked"
    return 0
  fi
  comment_line_state
  has=$?
  if ((has == 2)); then
    gl_log "could not tell whether the --comment of a gh issue close on $repo#$n carries an Outstanding line — close allowed unchecked"
    return 0
  elif ((has == 0)); then
    text="$comment"
    from="this close's own --comment"
  else
    fetch_issue "$n" ||
      gl_open "could not read comments on $repo#$n — close allowed unchecked"
    text="$(issue_field '.comments[-1].body // ""')" ||
      gl_open "could not read comments on $repo#$n — close allowed unchecked"
    from="#$n's newest comment — an older one does not count"
  fi
  [[ -n "$repo" ]] && tracker=(--tracker "$(wfc_repo_slug "$repo")")
  left="$(call_budget)"
  ((left >= 1)) ||
    gl_open "no time left in the guard's budget to judge $repo#$n's Outstanding line — close allowed unchecked"
  verdict="$(printf '%s' "$text" | "$timeout_bin" "$left" "$node_bin" "$here/lib/outstanding-line.js" \
    outstanding --self "$n" ${tracker[@]+"${tracker[@]}"} 2>/dev/null)"
  rc=$?
  case "$rc" in
    0)
      while IFS= read -r line; do
        [[ -n "$line" ]] && gl_log "Outstanding open-check on $repo#$n: $line"
      done < <(printf '%s' "$verdict" | jq -r '.unchecked[]?' 2>/dev/null)
      ;;
    # Node exits 1 on a crash too, printing no verdict (workflow-core#1255). Such a parser
    # disarms the check on every close, seen only in the guard log.
    1)
      [[ "$(printf '%s' "$verdict" | jq -r '.ok' 2>/dev/null)" == false ]] ||
        gl_open "the Outstanding-line parser exited 1 without a verdict on $repo#$n — close allowed unchecked"
      deny "$segment" "$from" "$verdict"
      ;;
    124) gl_open "the Outstanding-line parser ran out of the guard's time budget on $repo#$n — close allowed unchecked" ;;
    *) gl_open "the Outstanding-line parser did not run (exit $rc) on $repo#$n — close allowed unchecked" ;;
  esac
}

# The unparsed command, for the not-planned search below. Everything else
# reads the parsed form.
# shellcheck disable=SC2178  # not the `local -a raw` in guard-parse.sh; that one is function-local
raw="$(gp_subject)"

# Called once per command the tool call runs, with the segment as $1 and the
# command's own words — environment assignments already stripped — as $2 onward.
judge() {
  local segment="$1"
  shift

  [[ "$(basename "$1")" == "gh" ]] || return 0
  [[ "${2-}" == "issue" && "${3-}" == "close" ]] || return 0

  scan_close "${@:4}"

  # Abandoned work owes no disposition. The --reason value is read back, so a
  # `--reason completed` whose --comment says "not planned" is still judged;
  # only where that value cannot be read is the raw command searched for the
  # words, gated on the parsed segment carrying the flag.
  if ((has_reason)); then
    if ((reason_hidden)); then
      [[ "${raw,,}" == *"not"?"planned"* ]] && return 0
    elif [[ "${reason,,}" == "not"?"planned" ]]; then
      return 0
    fi
  fi

  # Empty only where gh got no positional argument, or an empty or bare-`#`
  # one: gh refuses each and closes nothing, so there is no close to judge and
  # no fault to record. Bash reading an unquoted `#12` as a comment is the
  # usual route (workflow-core#547).
  [[ -n "$issue" ]] || return 0

  [[ "$issue" =~ ^[0-9]+$ ]] ||
    gl_open "could not read the issue number from a gh issue close — close allowed unchecked"

  # Judging it against this repo instead would be a verdict on the wrong issue.
  ((repo_hidden)) &&
    gl_open "could not read the --repo value of a gh issue close — close allowed unchecked"

  # mantahostels#220 runs FIRST, and its verdict is the more useful one where both apply:
  # this close should not be happening at all, so answering the Outstanding rule
  # first would send the session to perfect a comment on it instead.
  #
  # NOT a command substitution: that subshell would discard $issue_json and cost
  # a second API call.
  if ! elsewhere_repo; then
    if card_not_done "$issue"; then
      deny_card "$segment" "$card_id" "$card_state" "$issue"
    elif [[ -n "$card_fault" ]]; then
      # gl_log, not gl_open: an unreadable roadmap says nothing about the
      # comments, so the Outstanding rule below can still reach a real verdict.
      gl_log "$card_fault — card state unchecked"
    fi
  fi

  # Before the Outstanding rule: unmet criteria mean the close is premature,
  # not merely badly worded.
  local criteria=0
  judge_criteria "$segment" "$issue" || criteria=$?

  judge_outstanding "$segment" "$issue"

  # After the Outstanding rule: the census reader is the slowest call, and
  # running it first could leave that rule no budget.
  judge_census "$segment" "$issue"

  # Reached only where the Outstanding rule passed without a fetch of its own
  # failing — a failed one exits through gl_open — so this is the outage's one
  # record.
  ((criteria == 2)) &&
    gl_log "could not read $repo#$issue — acceptance criteria unchecked"
  return 0
}

gp_walk_commands judge

gp_allow
