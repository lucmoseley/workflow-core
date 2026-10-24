#!/usr/bin/env bash
# PreToolUse guard: hand a session a tracker rule at the call that engages it,
# rather than pointing the session at a document (mantahostels#2493, spec mantahostels#2457 §T3).
#

# EIGHTEEN RULES, OVER TWENTY-TWO `gh` TABLE ROWS AND ONE NON-`gh` LIMB (mantahostels#2497,
# mantahostels#2592, mantahostels#2652, #2023). The vendored skills carry a tracker
# vocabulary this repo does not use, and scripts/inject-tracker-docs.sh can
# only say so and point at the document — which the session reads, or does
# not, long before it types the call.
#
# THE NON-`gh` LIMB IS WHY THE REGISTRATION CARRIES NO `if` (mantahostels#2592). The
# `written and verified` success signal binds at `node scripts/issue-body.js`,
# which is the command this repo prescribes IN PLACE OF the raw `gh` write — so
# the rule about reading its output can only be routed on a shape that is not a
# `gh` call at all. The guard therefore execs on every Bash call and returns
# on the first word of each command it does not know; a second, `gh`-scoped
# registration is barred by hook-registrations.test.ts's one-per-id pin.
#
# WHAT IS NOT ROUTED HERE, deliberately: the background-every-`gh`-call rule,
# which binds BEFORE the first tool call and so cannot be delivered by a hook on
# that call. It stays pasted, in scripts/inject-tracker-docs.sh.
#
# INJECTION ONLY — it never denies, and sets no `permissionDecision`. The
# tracker guards that DO deny are guard-issue-create-label.sh,
# guard-issue-close.sh, guard-issue-body.sh and guard-issue-phase-scope.sh.
#
# IMPLICIT: on an allowed call it injects the rules as
#   additionalContext and writes a `.rule-injected-*` latch under .claude/tmp/markers.
# JUSTIFIED: fail-safe — it adds no refusal.
# DEFEAT: `scripts/clear-rule-latch.sh` clears the latch and the rule is said
#   again; deleting the registration from self-plugin/hooks/hooks.json silences it.
#
# LIMITS
#  - THE MAPPING IS A TABLE, never inferred — TRIGGERS below. A `gh` shape with
#    no row emits nothing, silently.
#  - It matches the PARSED command form — a segment whose command word is `gh`,
#    followed by the row's own subcommand words — so a grep, an echo or a
#    heredoc mentioning those words emits nothing.
#  - THE issue-body.js LIMB IS THE ONE EXCEPTION TO THAT COMMAND-WORD TEST, and
#    it reads a WORD instead: any word whose basename is `issue-body.js`,
#    wherever it sits, PROVIDED THE NEXT WORD IS ONE OF THE SCRIPT'S WRITING
#    SUBCOMMANDS (mantahostels#2652). That is what reaches `node scripts/issue-body.js`,
#    `./scripts/issue-body.js` and a wrapper alike, while leaving both kinds of
#    read to spend nothing: a read of the FILE — `grep -n foo
#    scripts/issue-body.js` — and the script's own `show`, which writes
#    nothing. The latch is that rule's
#    only delivery, so a read spending it means the session's first real write
#    goes unsaid. What still costs a latched injection and nothing else: an
#    UNQUOTED mention where the script is its own word and a writing subcommand
#    is the next one — `echo node scripts/issue-body.js tick 12`, or a read
#    whose following word happens to be a subcommand name. A QUOTED body does
#    NOT: the parser MASKS a quoted span, so the raw glob gating this limb never
#    sees the text (mantahostels#2652).
#  - THE JOB-DIR LIMB reads every word of the WHOLE COMMAND, not just the `gh`
#    segment's, and not just a `--body-file` value — so `-F body=@<path>`,
#    `--input <path>` and the PIPED spelling the rule fragment itself names
#    (`cat <job-dir file> | gh issue comment <n> --body-file -`, whose path sits
#    in the `cat` segment) are all covered without enumerating flags or
#    segments (mantahostels#2652). The cost is an injection on a body
#    that merely QUOTES such a path, plus its command-wide widening: an
#    unrelated `gh` call sharing a command string with a job-dir path anywhere
#    is told the rule too.
#  - THE OTHER SPELLINGS OF A CREATION ARE OUT OF SCOPE HERE. `gh api --method
#    POST …/issues` and a `gh api graphql` `createIssue` mutation are both
#    chased by guard-issue-create-label.sh (mantahostels#511, mantahostels#519) and are not chased here,
#    where each would be a row in TRIGGERS.
#  - SO ARE THE OTHER SPELLINGS OF A LABEL EDIT (#2023): `gh api …/labels`, a
#    label set at creation, and scripts/park-blocked.sh's own `waiting:external`
#    write. Only `gh issue edit` and `gh pr edit` label flags are read.
#  - The rule is stated ONCE PER SESSION PER ID, by gp_rule's latch, and keyed
#    on the agent as well as the session so a subagent is told on its own
#    account.
#  - It FAILS OPEN on anything it cannot resolve, and the fail-open is RECORDED
#    (mantahostels#147). The one exception is gp_rule's store side, which exits 2 on a
#    fragment it cannot read (mantahostels#1762).
#  - It guards the Bash tool, so a creation from a script, from a workflow or
#    from the GitHub web UI sees no hook at all.

set -uo pipefail

# The shared parser (mantahostels#123), resolved from this file's own location because a
# hook runs with an arbitrary cwd. The gate is ONE name, gp_begin, never
# `source`'s exit status (mantahostels#157). lib/guard-log.sh is sourced first and
# separately so the parser's own absence is recordable (mantahostels#147).
here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null

# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null
declare -F gp_begin >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-parse.sh did not load — every tracker call allowed unstated"
  exit 0
}

# shellcheck source=scripts/lib/guard-job-dir.sh
source "$here/lib/guard-job-dir.sh" 2>/dev/null

# shellcheck source=scripts/lib/gh-body.sh
source "$here/lib/gh-body.sh" 2>/dev/null
GB_SUBCMD='issue[[:space:]]+comment'
GB_WHAT='gh issue comment'

gp_begin '.tool_input.command' command

# The ids this call has engaged. Filled by judge().
matched=()

# The prelude's own latch key, in gp_rule_told's `warn.<id>` namespace. One
# prelude serves every row, so it is keyed on a name of its own rather than on
# any one rule's id.
PRELUDE_LATCH=tracker-rules-prelude

# Whether the table has already matched id $1 on this call.
engaged() {
  local id
  for id in ${matched+"${matched[@]}"}; do [[ "$id" == "$1" ]] && return 0; done
  return 1
}

# Record that this call engages rule $1.
want() {
  engaged "$1" || matched+=("$1")
}

# --- the flag predicates a TRIGGERS row may name -----------------------------
#
# Each takes the command's own words — `gh` itself included — and answers
# whether the row applies. A row naming `-` runs none of these and matches on
# the subcommand alone.

# A `gh issue edit` that writes the body whole — the long flags, each `=`-joined
# form, and gh's own short spellings `-b`/`-F`. guard-issue-body.sh DENIES every
# one of those, bundles included (mantahostels#132).
writes_body() {
  local w
  for w in "$@"; do
    case "$w" in
      --body | --body=* | --body-file | --body-file=* | -b | -b=* | -F | -F=*) return 0 ;;
    esac
  done
  return 1
}

# A `gh issue edit` that takes the issue. `--add-assignee` only: `--remove-assignee`
# is a release and engages no claim rule.
adds_assignee() {
  local w
  for w in "$@"; do
    case "$w" in --add-assignee | --add-assignee=*) return 0 ;; esac
  done
  return 1
}

# A `gh api` call on an issue's native dependency or sub-issue endpoint. The
# path is one word, so the test is on the word rather than on the whole command:
# an endpoint mentioned inside a `--jq` filter or a `-f` field is not a call to
# it.
#
# THE QUERY STRING IS WHY THE ARMS END IN `*`. The read the fragment tells a
# session to make is the PAGED one — `…/sub_issues?per_page=100`, the default
# being 30 — so an arm anchored at the end of the word would miss exactly the
# call this rule exists for. `/sub_issue` matches the singular DELETE re-root
# spelling, and `blocking` the other side of the dependency edge.
dependency_endpoint() {
  local w
  for w in "$@"; do
    case "$w" in
      */dependencies/blocked_by* | */dependencies/blocking* | */sub_issue | */sub_issue\?* | */sub_issues*) return 0 ;;
    esac
  done
  return 1
}

# A `gh` call sharing its command string with a path under the background job's
# scratch tree. `gh` reads one fine — the real risk is
# `$CLAUDE_JOB_DIR` failing to resolve at all (mantahostels#2088), which breaks the path
# before `gh`, or any tool, ever opens it.
#
# The answer is taken command-wide by scan_job_dir below, and this predicate
# only reports it (mantahostels#2652).
#
# It FAILS OPEN where the lib did not load, and says so: a guard that cannot
# tell a job-dir path from any other would fire on every `gh` call.
#
# `gl_log`, NOT `gl_open` (mantahostels#2652). gl_open EXITS 0, so it would stand the whole
# guard down and drop every OTHER rule the call engaged. One absent predicate
# costs its own rule and nothing else.
job_dir_path() {
  declare -F gjd_is_job_dir >/dev/null 2>&1 || {
    declare -F gl_log >/dev/null 2>&1 &&
      gl_log "lib/guard-job-dir.sh did not load — rule:gh-job-dir-unreadable was not selected"
    return 1
  }
  ((job_dir_seen))
}

# A `gh issue comment` whose body opens `**Blocked` (#2309), the opening
# check-issue-labels.js's BLOCKED_COMMENT matches. The body is read through
# lib/gh-body.sh, in the spellings record-acts.sh reads; one it cannot read
# matches nothing, logged. It FAILS OPEN where the lib did not load, as
# job_dir_path does.
opens_blocked() {
  declare -F gb_body >/dev/null 2>&1 || {
    declare -F gl_log >/dev/null 2>&1 &&
      gl_log "lib/gh-body.sh did not load — rule:blocked-ticket-gate was not selected"
    return 1
  }
  # shellcheck disable=SC2034 # body_missing: lib/gh-body.sh's answer, kept local.
  local body="" body_hidden=0 body_given=0 body_missing="" body_fault=""
  gp_scan_flags "-b --body -F --body-file -R --repo" comment_body_arg -- "${@:3}"
  [[ -n "$body_fault" ]] && declare -F gl_log >/dev/null 2>&1 &&
    gl_log "$body_fault — rule:blocked-ticket-gate not judged"
  ((body_given && !body_hidden)) || return 1
  [[ "$body" =~ ^[[:space:]]*\*\*Blocked ]]
}

comment_body_arg() {
  [[ "$1" == opt ]] || return 0
  case "$2" in
    -b | --body) gb_body "$3" ;;
    -F | --body-file) gb_body_file "$3" ;;
  esac
  return 0
}

# A `gh` call that reads check runs, which the token cannot (rule:gh-cli-limits):
# a `--json` field list naming `statusCheckRollup`, or the REST check-runs
# endpoint. On the word, as dependency_endpoint is — but unquoted first, since
# a field list is often quoted and the parser masks a quoted span. The raw-text
# gate keeps those gp_literal forks off every other `gh` call, the row's empty
# subcommand field reaching all of them.
reads_check_runs() {
  [[ "$(gp_subject)" == *statusCheckRollup* || "$(gp_subject)" == */check-runs* ]] || return 1
  local w lit
  for w in "$@"; do
    lit="$(gp_literal "$w")" || :
    case "$lit" in *statusCheckRollup* | */check-runs*) return 0 ;; esac
  done
  return 1
}

# Whether any word after the `--` is one of the long or short flags before it,
# the long one's `=`-joined form included.
has_flag() {
  local -a flags=()
  while [[ $# -gt 0 && "$1" != "--" ]]; do
    flags+=("$1")
    shift
  done
  shift
  local w f
  for w in "$@"; do
    for f in "${flags[@]}"; do
      [[ "$w" == "$f" || ("$f" == --* && "$w" == "$f="*) ]] && return 0
    done
  done
  return 1
}

# `gh run list` filtered by commit. `-c` is gh's own short spelling of `--commit`.
names_commit() { has_flag --commit -c -- "$@"; }

# `gh issue view --comments`. Whether the issue has comments is unknowable
# before the call, so every such read is told. `-c` is gh's own short
# spelling of `--comments`.
reads_comments() { has_flag --comments -c -- "$@"; }

# Every label a `gh issue edit` or `gh pr edit` adds or removes, one per line:
# each `--add-label`/`--remove-label` value, joined or not, split on gh's own
# comma. Unquoted through gp_literal, so `--add-label "a,urgent"` yields both.
label_edits=""
label_values() {
  local -a ws=("$@")
  local i w v
  for i in "${!ws[@]}"; do
    w="$(gp_literal "${ws[i]}")" || :
    case "$w" in
      --add-label=* | --remove-label=*) v="${w#*=}" ;;
      --add-label | --remove-label) v="$(gp_literal "${ws[i + 1]-}")" || : ;;
      *) continue ;;
    esac
    printf '%s\n' "${v//,/$'\n'}"
  done
}

# A label edit at all — the role table binds on every one.
edits_labels() {
  label_edits="$(label_values "$@")"
  [[ -n "$label_edits" ]]
}

# A label edit naming `urgent`, or any `waiting:` value.
labels_urgent() { grep -qx 'urgent' <<<"$label_edits"; }
labels_waiting() { grep -q '^waiting:' <<<"$label_edits"; }

# --- THE TABLE ---------------------------------------------------------------
#
# `<subcommand words>|<predicate or ->|<the ids the shape engages>`. A row's id
# order has no effect — the emission order is the gp_rule call's, at the foot of
# this file. Adding a rule
# adds a row here, an anchored region and a TRIGGERS entry in
# scripts/generate-rule-fragments.js, a needle in
# scripts/guard-fire-needles.json, and — at the foot of this file — a skip line
# and its id in the gp_rule call, which carries the priority order.
#
# THE SUBCOMMAND FIELD IS MATCHED WHOLE, word for word, against the words
# following `gh`. `api` is one word; `issue create` is two; an empty field
# matches every `gh` call. A label row's `edits_labels` comes before its
# `labels_*` rows, which read what it recorded.
TRIGGERS=(
  "issue create|-|create-command-shape takes-value-vocabulary issue-parent-unplaced issue-created-assigned citation-inferred-number"
  "issue close|-|close-outstanding-line ticket-criteria-unticked"
  "issue edit|writes_body|issue-body-raw-write"
  "issue edit|adds_assignee|issue-claim-scope"
  "issue comment|-|citation-number-first"
  "issue comment|opens_blocked|blocked-ticket-gate"
  "api|dependency_endpoint|dependency-edge-false-success"
  "issue comment|job_dir_path|gh-job-dir-unreadable"
  "issue create|job_dir_path|gh-job-dir-unreadable"
  "api|job_dir_path|gh-job-dir-unreadable"
  # The two remaining writes that take a body (mantahostels#2652). `gh issue close
  # <n> --comment "$(cat <p>)"` is the documented resolution route, so its
  # silent no-op loses the comment a close is refused without.
  "issue edit|job_dir_path|gh-job-dir-unreadable"
  "issue close|job_dir_path|gh-job-dir-unreadable"
  # The reads this machine's token or gh version gets wrong (#2023).
  "pr checks|-|gh-cli-limits"
  "|reads_check_runs|gh-cli-limits"
  "run list|names_commit|gh-cli-limits"
  "issue view|reads_comments|gh-cli-limits"
  "issue edit|edits_labels|triage-role-labels"
  "issue edit|labels_urgent|urgent-label"
  "issue edit|labels_waiting|waiting-external-vocabulary"
  "pr edit|edits_labels|triage-role-labels"
  "pr edit|labels_urgent|urgent-label"
  "pr edit|labels_waiting|waiting-external-vocabulary"
)

# The script's WRITING subcommands, its USAGE block's list less `show` (mantahostels#2652).
# The limb reads the word AFTER the script to tell a run from a read, and `show`
# is a read: it writes nothing, so the `written and verified` success signal the
# rule is about never appears in its output.
# scripts/guard-tracker-rules.test.ts pins this against that USAGE block, so a
# subcommand added there and not here fails rather than dropping out silently.
ISSUE_BODY_SUBCOMMANDS=" append append-section append-decision delete-lines tick annotate replace "

# Called once per command the tool call runs, with the segment as $1 and the
# command's own words — environment assignments already stripped — as $2 onward.
judge() {
  shift # the masked segment, unused: this guard reads the words
  # The non-`gh` limb, judged first because it reads WORDS rather than a
  # command word: `node scripts/issue-body.js tick 12 --match "…"` has `node`
  # at its head, and `./scripts/issue-body.js` has the script itself.
  #
  # A RAW-TEXT GLOB GATES THE gp_literal CALL, and does the fork arithmetic:
  # the registration carries no `if`, so this loop runs over every word of every
  # Bash call the session makes, and an unconditional `gp_literal` — a command
  # substitution, so a fork — would cost one process per word of all of them.
  # The glob is a superset of what gp_literal can yield, a masked span holding
  # the text either way, so gating on it drops no match. `${lit##*/}` for the
  # same reason, `basename` being a second fork.
  #
  # THE WORD AFTER IT DECIDES (mantahostels#2652): a writing subcommand is what a RUN of the
  # script always has and a read of it almost never does. LIMITS has the rest.
  local w lit next i
  local -a segwords=("$@")
  for i in "${!segwords[@]}"; do
    w="${segwords[i]}"
    [[ "$w" == *issue-body.js* ]] || continue
    lit="$(gp_literal "$w")" || :
    [[ "${lit##*/}" == "issue-body.js" ]] || continue
    next="$(gp_literal "${segwords[i + 1]-}")" || :
    [[ "$ISSUE_BODY_SUBCOMMANDS" == *" $next "* ]] && {
      want issue-body-success-signal
      break
    }
  done
  [[ "$(basename "$1")" == "gh" ]] || return 0
  shift # `gh` itself, so $@ is the subcommand and its flags

  local row pred rest n ok
  local -a subcmd ids
  # The words after `gh`, as an array: `[[ "${@:i+1:1}" ]]` concatenates inside
  # `[[ ]]` rather than indexing (SC2199), so the positionals are copied once.
  local -a words=("$@")
  for row in "${TRIGGERS[@]}"; do
    # `read -r -a` splits each field into a real array, so no unquoted expansion
    # — and therefore no SC2086 suppression — stands between the table and the
    # match. The herestrings are the table's own literals, never the command's.
    read -r -a subcmd <<<"${row%%|*}"
    rest="${row#*|}"
    pred="${rest%%|*}"
    read -r -a ids <<<"${rest#*|}"

    # The subcommand words, matched in order and in full against the words
    # after `gh`.
    ok=1
    for i in "${!subcmd[@]}"; do
      [[ "${words[i]-}" == "${subcmd[i]}" ]] || {
        ok=0
        break
      }
    done
    ((ok)) || continue

    [[ "$pred" == "-" ]] || "$pred" "$@" || continue

    for n in "${ids[@]}"; do want "$n"; done
  done
}

# --- the command-wide job-dir pre-pass ---------------------------------------
#
# Whether ANY segment of this command names a job-dir path, answered before the
# table walk so `job_dir_path` can report it on the `gh` segment (mantahostels#2652).
#
# GATED ON THE RAW SUBJECT CONTAINING `gh` AT ALL, which takes most of the cost
# out: the registration carries no `if`, so this guard runs on every Bash call
# the session makes, and an unconditional pre-pass would cost one `gp_literal`
# fork per word of all of them. Every job-dir row is a `gh` subcommand, so a
# command with no `gh` in its text can match none of them and the scan would be
# spent for nothing.
#
# IT IS A BARE SUBSTRING, not a word test: the subject is raw text, quoting and
# all, so a word test on it would be a second parse.
job_dir_seen=0
scan_job_dir() {
  shift
  local w lit
  ((job_dir_seen)) && return 0
  for w in "$@"; do
    lit="$(gp_literal "$w")" || :
    [[ -n "$lit" ]] || continue
    gjd_is_job_dir "$lit" && {
      job_dir_seen=1
      return 0
    }
  done
  return 0
}
if declare -F gjd_is_job_dir >/dev/null 2>&1 && [[ "$(gp_subject)" == *gh* ]]; then
  gp_walk_commands scan_job_dir
fi

gp_walk_commands judge

((${#matched[@]})) || gp_allow

# The framing sentence (mantahostels#2369). IT STANDS ALONE, never ending in a colon:
# gp_rule emits a held prelude on its own fail-opens, with no fragments under it.
#
# LATCHED SEPARATELY (mantahostels#2275): gp_rule's own latch is unreachable from
# here, so an ungated prelude would be paid on every matching `gh` call. The
# mark goes through gp_rule_latch_after, never written here, because gp_rule
# exits and a mark written first would precede the emission (mantahostels#2528).
if ! gp_rule_told "$PRELUDE_LATCH"; then
  gp_rule_prelude "This call engages tracker rules THIS repo authors and the vendored skills do not carry — docs/agents/issue-tracker.md and docs/agents/triage-labels.md are their home, and the vendored defaults are not this repo's."
  gp_rule_latch_after "$PRELUDE_LATCH"
fi

# THE IDS ARE NAMED LITERALLY: EMIT_RULE_RE in scripts/lib/rule-emission.js
# reads only a statement-initial `gp_rule <id>`, so `gp_rule "${matched[@]}"`
# would spend this guard's bytes against no cap. gp_rule_skip (mantahostels#1805)
# takes out each id the table did not match. gp_rule stops at the first id
# that does not fit GP_RULE_CAP, so the costliest breach is said first.
engaged blocked-ticket-gate || gp_rule_skip blocked-ticket-gate
engaged citation-inferred-number || gp_rule_skip citation-inferred-number
engaged citation-number-first || gp_rule_skip citation-number-first
engaged close-outstanding-line || gp_rule_skip close-outstanding-line
engaged create-command-shape || gp_rule_skip create-command-shape
engaged dependency-edge-false-success || gp_rule_skip dependency-edge-false-success
engaged gh-cli-limits || gp_rule_skip gh-cli-limits
engaged gh-job-dir-unreadable || gp_rule_skip gh-job-dir-unreadable
engaged issue-body-raw-write || gp_rule_skip issue-body-raw-write
engaged issue-body-success-signal || gp_rule_skip issue-body-success-signal
engaged issue-claim-scope || gp_rule_skip issue-claim-scope
engaged issue-created-assigned || gp_rule_skip issue-created-assigned
engaged issue-parent-unplaced || gp_rule_skip issue-parent-unplaced
engaged takes-value-vocabulary || gp_rule_skip takes-value-vocabulary
engaged ticket-criteria-unticked || gp_rule_skip ticket-criteria-unticked
engaged triage-role-labels || gp_rule_skip triage-role-labels
engaged urgent-label || gp_rule_skip urgent-label
engaged waiting-external-vocabulary || gp_rule_skip waiting-external-vocabulary

gp_rule gh-job-dir-unreadable issue-body-success-signal gh-cli-limits urgent-label waiting-external-vocabulary triage-role-labels create-command-shape takes-value-vocabulary issue-parent-unplaced issue-created-assigned close-outstanding-line ticket-criteria-unticked issue-body-raw-write issue-claim-scope dependency-edge-false-success blocked-ticket-gate citation-number-first citation-inferred-number

gp_allow
