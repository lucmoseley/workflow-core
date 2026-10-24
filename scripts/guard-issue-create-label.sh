#!/usr/bin/env bash
# PreToolUse guard: every issue created from a Bash call carries a `takes:`
# label (mantahostels#453, which ruled it). A create on an Anthropic repo is
# guard-anthropic-report.sh's to refuse (#1987).
#
# Why: `takes:` is the label naming the command that opens an issue, and every
# open issue must carry exactly one — a missing value is a defect, never a state
# to interpret. The guard reads the COMMAND, never the call's output: a backgrounded
# call's output is the harness's job stub (mantahostels#453).
#
# mantahostels#136 rejected a label deny as "not always knowable at creation" — true of
# `wayfinder:*` and `kind:`, never of `takes:`, where `takes:triage` always
# fits. It stands, and does not cover this axis (mantahostels#470).
#
# The value is validated too; FLAG_FORM_COST and API_FORM_COST say why.
#
# DENY, not warn (mantahostels#103): deny on a structured fact, warn where the hook is
# inferring. Whether a label is present, and whether its value is one of seven,
# are facts read off the command.
# The GraphQL route is the one place the guard must infer, and it warns there
# instead — see judge_graphql.
#
# LIMITS
#  - It matches the parsed command form — a segment whose command word is `gh`,
#    subcommand pair `issue create` — never a substring, so a grep, an echo or a
#    heredoc mentioning `gh issue create` passes. So does a wrapped call —
#    `timeout N gh …`, `env gh …` — whose command word is not `gh`.
#  - `gh api --method POST …/issues` IS chased (mantahostels#511), and gh's own default with
#    it — a call carrying fields and no --method at all is a POST.
#  - `gh api graphql` carrying a `createIssue` mutation IS chased (mantahostels#519), by
#    reading its `query` field back out of the span the parser blanked. A
#    mutation carrying no `labelIds` at all is denied; one carrying labelIds is
#    WARNED, GraphQL taking opaque node ids that name no label this guard can
#    read. A query it cannot read at all — `-F query=@file`, `--input`, a
#    variable, a command substitution — is left in SILENCE, the residual this
#    route keeps: warning there would fire almost entirely on the read-only
#    queries this repo runs daily, and guard-issue-body.sh already warns on
#    exactly those commands, so the opacity still reaches the session. A `)`
#    inside a string literal truncates the arguments, and warns rather than
#    denying — see judge_graphql.
#  - A PreToolUse hook sees Bash tool calls only, so AN ISSUE CREATED BY A
#    SCRIPT ESCAPES ENTIRELY. The GitHub web UI escapes the same way.
#    scripts/check-issue-labels.js stays the only control for both.
#  - THE `takes:human` LIMB (mantahostels#2775) reads the create's BODY, and only on the
#    flag form and the REST form, where the body text is on the command, in a
#    file on disk, or in a heredoc piped into `--body-file -` (mantahostels#3439) — see
#    gb_stdin_heredoc (lib/gh-body.sh) for the one-create shapes it trusts. A body it cannot
#    read — a `$VAR`, a `$(cat …)`, `--body-file -` fed from anything but such a
#    heredoc or a `cat <path> |`, an unquoted heredoc whose body would expand, a
#    `-F body=@file` — is REFUSED (#668), and the refusal names the heredoc
#    form. The
#    GraphQL route never reaches it at all: labels there are opaque node ids, so
#    the guard cannot tell a `takes:human` creation from any other one.
#  - THE REPO-FILE LIMB (mantahostels#3555, ruled on mantahostels#3503) refuses a `takes:human` whose
#    Outside line names a repo file as the act's product — a backticked path
#    under a source directory, a filename with a source extension, or a
#    file-producing tool (Inkscape, Figma, Photoshop, a spreadsheet). It reads
#    the Outside line alone and lexically: a line naming the act without the
#    path passes, and that is the escape it keeps.
#  - THE FOUNDER-ACT LIMB (#1097, ruled on #1077) refuses a `takes:human`, on
#    create and on relabel, whose Outside line names none of the founder's own
#    acts (FOUNDER_ACT_RE) and whose body carries no `Tried:` list of three
#    items, judged after the repo-file limb. Lexical, so a list word in a
#    non-act sense passes, and so do three unreal or same-kind methods.
#  - THE CLOSE-WHEN LIMB (#983) refuses a `takes:human` body, on create and on
#    relabel, carrying no `**Close when:**` line, after the four Outside-line
#    tests pass. Presence only. The refusal carries the `founder-deliverable`
#    fragment; a body passing every limb gets a one-line pointer to it.
#  - THE EDIT ROUTE (mantahostels#3555) reaches the same limbs through `gh issue edit
#    <n>… --add-label takes:human`. The body is read
#    off the command where the edit also carries an inline `--body`, and
#    otherwise FETCHED — `timeout 3 gh issue view <n> --json body`, at most TWO
#    fetches a command, so a hung `gh` costs 6 s under the 10 s hook ceiling;
#    a third number and beyond fail open, recorded. `gh` is `$WFC_GH`, else
#    `gh` (base §N7). A fetch that fails, a `gh` that cannot be found, a number
#    the guard cannot read (a `$VAR`, a URL it cannot parse) all FAIL OPEN,
#    recorded. A `--body` it cannot read, or any `--body-file`, is REFUSED
#    (#669): relabelling alone always has its body fetched, and the refusal
#    names that spelling.
#    `--remove-label` and every other edit pass unjudged, and a relabel by
#    script, GraphQL or the web UI still escapes; check-issue-labels.js catches
#    those after the fact.
#  - THE BLANK-BODY LIMB (mantahostels#3443) refuses, whatever the label, a flag-form create
#    whose body is empty or whitespace-only — on the command, in a heredoc, or in
#    a file — or whose `--body-file` path, or the one `cat <path> | gh issue
#    create … --body-file -` pipes in, is absent from disk. A relative path
#    resolves against lib/guard-parse.sh's gp_cwd (mantahostels#3453), which owns what a
#    `cd` does to it; a directory it cannot know and an unreadable body file
#    both fail open, recorded — on a takes:human create, refused (#668). A command naming the file's basename BEFORE the
#    read is taken to write it first and passes unread, unrecorded: a script writing a path the
#    command never names is the false refusal left, and a same-named file in
#    another directory, or a basename inside a longer word, the missed one. The
#    REST and GraphQL routes are not judged, and neither is a create carrying no
#    body flag at all, which gh itself refuses outside a terminal.
#  - THE BASIS LIMB (#672) refuses, on a body the blank-body limb read, a gate
#    line or a prose wait with no `**Gate basis:**`, or a window in either that
#    the basis does not name (#823) — see judge_basis. It checks the basis names
#    each window, never that it holds up.
#  - THE SECOND-MAP LIMB (#717) refuses a flag-form or REST create carrying
#    `wayfinder:map` while an open map's Destination still reads the new-repo
#    placeholder — see judge_second_map (#1464). The GraphQL route is not
#    judged: its labels are opaque node ids, so telling a map create apart
#    takes a lookup the hook's time limit has no room for — mantahostels#519's
#    ground for the takes: limb. A `GH_REPO=…` on the create is not read: where
#    no --repo or spelled-out REST endpoint names the repo, the maps are listed
#    for the create's cwd, so that create is judged against the wrong repo.
#  - It says nothing about PLACEMENT. The parent is not in the create command,
#    so an unparented issue still passes; scripts/check-issue-orphans.js remains
#    the only control there (mantahostels#453).
#  - Wired with `if: Bash(gh *)` (mantahostels#2127; best-effort:
#    docs/agents/guard-authoring.md's surface 4, which fails toward
#    running) — not exec'd unless some segment of the command leads with
#    `gh`. NEARLY the same test as this guard's own basename check (in
#    judge), which differs on one spelling: `/usr/bin/gh …` passes the
#    basename but matches no `Bash(gh *)` pattern, so a path-spelled call is
#    unjudged.
#  - It FAILS OPEN, house style (mantahostels#103 §6): a label value it cannot read — an
#    unexpanded $VAR, a command substitution — an unparseable command, a missing
#    jq or an unreadable shared parser all allow the creation through, and all
#    are RECORDED (mantahostels#147) via lib/guard-log.sh for check-guard-errors.js to
#    report under `npm run status`.
#  - THE RULE IT PRINTS lives in docs/agents/rules/, not here (mantahostels#1649, spec
#    mantahostels#1641): CLAUDE.md keeps a trigger line naming the id, and this guard splices
#    the fragment into its refusal. An unreadable fragment is one of THREE faults
#    this guard does not fail open on and does not log — the command is resolved
#    and known bad, only the rule could not be read; it refuses with a pointer
#    to the fragment instead. The others are an unreadable takes:human body on a
#    create (#668) and on a relabel (#669), refused above.
#  - It guards the Bash tool, so it binds agent sessions and not the founder's
#    own terminal (mantahostels#109).

set -uo pipefail

# The closed set, from docs/agents/triage-labels.md §`takes:`. One line, one
# word each: guard-issue-create-label.test.ts reads this line and asserts the
# doc names every value.
TAKES_VALUES=(wayfinder to-spec to-tickets implement triage human children)

# The line a `takes:human` body must carry (mantahostels#2775). `takes:human` means the next
# action happens OUTSIDE Claude Code entirely, and the test for it is
# mantahostels#804's: name the concrete outside act. The guard cannot judge whether a
# named act is real, and does not try.
HUMAN_MARKER="Outside Claude Code:"

# Mirrors OUTSIDE_LINE in scripts/lib/takes-label.js (#994): the marker, then
# optional blanks and bold asterisks, then a real character on the same line.
# A bare marker names no act.
HUMAN_MARKER_RE="$HUMAN_MARKER"'[[:blank:]*]*[^[:space:]*]'

# The Outside line itself, marker to end of line, for the repo-file limb.
HUMAN_LINE_RE="$HUMAN_MARKER"$'[^\n]*'

# Mirrors REPO_FILE_ACT in scripts/lib/takes-label.js (mantahostels#3555): an act whose
# product is a file in this repository is never an outside act. Three limbs —
# a backticked path under a source directory, a filename with a source
# extension, a file-producing tool — equivalent to the JS and unpinned, so no
# `\b` and no case fold. The directories, extensions and tools go no wider
# than mantahostels#3555 item 4 lists: a miss is caught by nothing, a false deny by a
# founder.
REPO_FILE_RE='`(docs|app|scripts|components|lib|public)/[^`]*`|(^|[^A-Za-z0-9_])[A-Za-z0-9_-]+\.(svg|png|md|js|ts)($|[^A-Za-z0-9_])|[Ii]nkscape|[Ff]igma|[Pp]hotoshop|[Ss]preadsheet'

# Mirrors BARRED_ACT in scripts/lib/takes-label.js (#140). A real outside
# act names an ACTION — submit, sign, pay, email, click, ask. An Outside line
# that instead names a PROHIBITION is the barred-is-not-impossible mistake
# mantahostels#2775 ruled on, written into the one field meant to disprove it.
# Every alternative names an AGENT or a SESSION as the barred subject. A
# prohibition about the WORLD is often part of a real errand — "once submitted
# it may not be edited", "ask the bank why the account is barred", "the landlord
# says we are not permitted to sublet" — and passes (#140).
BARRED_RE='[Nn]o (agent|session) (may|can)|[Aa]n agent (may not|cannot|is not permitted|is barred)|[Aa]gents? (are|is) (barred|not permitted)|(may not|cannot) be [a-z]+ by (an agent|a session)|[Nn]o agent is (allowed|permitted)'

# Mirrors CLOSE_WHEN_LINE in scripts/lib/takes-label.js (#983). `[[:blank:]]`,
# not `[[:space:]]`: an empty marker must not borrow the next line's text.
CLOSE_WHEN_RE='Close when:[[:blank:]*]*[^[:space:]*]'

# Mirrors FOUNDER_ACTS in scripts/lib/takes-label.js (#1077 Q1 (A)).
FOUNDER_ACTS=(
  "pay, buy or subscribe"
  "sign or accept terms"
  "delete"
  "install an app"
  "accept an invite"
  "grant access"
  "OAuth Authorize"
  "a CAPTCHA guarding an act he is taking"
  "card entry"
  "a one-time code"
  "phone verification"
  "signing a site in for the first time"
  "an act Claude Code's automatic permission check refused (never the same act by another path)"
  "a phone call, an in-person act, or an act in a desktop or phone app"
  "sending anything a person outside reads"
)

# Mirrors FOUNDER_ACT_WORD in scripts/lib/takes-label.js (#1097), character for
# character; matched against the lowercased line, the JS's /i.
FOUNDER_ACT_RE='(^|[^a-z0-9])(pay|payment|buy|purchase|subscribe|sign|signature|accept|terms|delete|install|invite|grant|authorise|authorize|oauth|captcha|card|one-time code|otp|verification|phone|call|in[ -]person|desktop app|phone app|iphone|refused|send|email|e-mail|message|reply|post|submit|apply|application|register|registration|linkedin|profile|form)(s|es|d|ed|ing|ted|ting)?($|[^a-z0-9])|(^|[^a-z0-9])(paid|bought|purchasing|subscribing|deleting|inviting|authorising|authorizing|phoning|messaging|replied|replies|applied|applies)($|[^a-z0-9])'

# Mirror TRIED_LINE, LIST_ITEM and TRIED_MIN in scripts/lib/takes-label.js.
TRIED_LINE_RE='^[[:blank:]]*(\*\*)?Tried(:\*\*|\*\*:|:)'
LIST_ITEM_RE='^([[:blank:]]*)([-*+]|[0-9]+[.)])[[:blank:]]+[^[:space:]]'
TRIED_MIN=3

# lib/guard-log.sh is sourced FIRST and separately, so the one fault that
# disarms this guard entirely — the parser failing to load — is itself
# recordable (mantahostels#147). The gate is ONE name, `gp_begin` — never `source`'s own
# exit status. Why that is enough is on gp_begin in lib/guard-parse.sh (mantahostels#157).
here="$(dirname "${BASH_SOURCE[0]}")"
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

# shellcheck source=scripts/lib/gh-body.sh
source "$here/lib/gh-body.sh" 2>/dev/null
GB_SUBCMD='issue[[:space:]]+create'
GB_WHAT='gh issue create'
declare -F gb_body >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/gh-body.sh did not load — every issue creation allowed unchecked"
  exit 0
}

gp_begin '.tool_input.command' command

# The seven, rendered for a human, in the order the doc's table lists them.
values_line() {
  local v out=""
  for v in "${TAKES_VALUES[@]}"; do out+="  takes:$v"$'\n'; done
  printf '%s' "$out"
}

is_valid() {
  local v want
  v="$1"
  for want in "${TAKES_VALUES[@]}"; do [[ "$v" == "$want" ]] && return 0; done
  return 1
}

# One --label word, which gh lets carry a comma-separated list. Appends each to
# $labels; sets $unreadable where the word's text cannot be recovered, which is
# a fail-open rather than a verdict — the hidden text may be the right label.
push_label() {
  local word="$1" text part
  text="$(gp_literal "$word")" || {
    unreadable="could not read a --label value on a gh issue create"
    return 0
  }
  local IFS=,
  for part in $text; do
    [[ -n "$part" ]] && labels+=("$part")
  done
}

# The flags `gh issue create` takes a value for. The shared reader is given the
# whole set (mantahostels#477): without it, `gh issue create --title --label` has its title
# read as a flag, and the bare-word check below — which is what catches `gh
# issue create $ARGS` — fires on any value the parser left an expansion in.
CREATE_VALUE_FLAGS="-t --title -b --body -F --body-file -a --assignee \
-m --milestone -p --project -T --template -R --repo -l --label"

# Read a `gh issue create` invocation's own arguments. Sets $labels, $unreadable
# and $helping.
scan_create() {
  labels=()
  unreadable=""
  helping=0
  gp_scan_flags "$CREATE_VALUE_FLAGS" create_arg -- "$@"
  return 0
}

# One argument of that invocation, as <kind> <name> <value>. Returning non-zero
# stops the scan, which is how `--help` — a command that files nothing — ends it.
create_arg() {
  case "$2" in
    --help | -h)
      helping=1
      return 1
      ;;
  esac
  case "$1" in
    opt) case "$2" in
      --label | -l) push_label "$3" ;;
      --body | -b) gb_body "$3" ;;
      --body-file | -F) gb_body_file "$3" ;;
      --repo | -R) create_repo="$(gp_literal "$3")" || create_repo_hidden=1 ;;
    esac ;;
    dangling)
      [[ "$2" == --label || "$2" == -l ]] &&
        unreadable="a gh issue create ends in a --label with no value"
      ;;
    # A bare word gh issue create has no use for. An expansion here can hold the
    # whole argument list — `gh issue create $ARGS` — so the labels this scan
    # found say nothing about what will actually be sent.
    arg) case "$3" in
      *'$'* | *'`'*) unreadable="could not read the arguments of a gh issue create" ;;
    esac ;;
  esac
  return 0
}

# The rule this guard prints (mantahostels#1649, spec mantahostels#1641). Operative text in
# docs/agents/rules/issue-takes-label.txt; CLAUDE.md keeps a trigger line only,
# so these refusals are where the rule reaches a session.
#
# An unreadable fragment is NOT a fail-open and is not logged: the command is
# resolved and known bad, only the RULE could not be read.
#
# Sourced here, not left to gp_script_path, for sp_shell_word (#1764).
# shellcheck source=scripts/lib/script-path.sh
source "$here/lib/script-path.sh" 2>/dev/null
declare -F sp_shell_word >/dev/null || sp_shell_word() { printf '%q' "$1"; }
LABEL_RULE_FALLBACK="Every gh issue create carries a takes: label; the rule itself could not be read from docs/agents/rules/issue-takes-label.txt. Read that file before doing anything else."

# $2 is the corrected command to show.
deny_missing() {
  local reason
  IFS= read -r -d '' reason <<EOF || :
This creates an issue with no \`takes:\` label: @CMD@

$(gp_rule_text issue-takes-label "$LABEL_RULE_FALLBACK")

Add one of:

$(values_line)

  $2

Or file, label and place it in one checked call: node $(gp_script_path file-issue.js) --title "…" --label takes:… (--parent <n> | --standalone "<why>") --body-file - (#533).
EOF
  gp_deny "$reason" "$1"
}

# $3 is what the wrong value costs, which is not the same on the two routes: gh
# refuses a label it does not know, the REST API does not.
deny_invalid() {
  local reason val="$2"
  IFS= read -r -d '' reason <<EOF || :
This creates an issue with a \`takes:\` label that does not exist — \`takes:$val\`: @CMD@

$3

$(gp_rule_text issue-takes-label "$LABEL_RULE_FALLBACK")

The seven values, in full:

$(values_line)
EOF
  gp_deny "$reason" "$1"
}

acts_line() {
  local IFS=';'
  local joined="${FOUNDER_ACTS[*]}"
  printf '%s' "${joined//;/; }"
}

is_founder_act() {
  [[ "${1,,}" =~ $FOUNDER_ACT_RE ]]
}

# The longest `Tried:` list in body $1: the items on the very next lines at the
# first item's indent. A deeper item is its method's detail and is skipped;
# anything else ends the count, a blank line included — as triedCount.
tried_count() {
  local -a lines
  local i j indent n best=0
  mapfile -t lines <<<"$1"
  for ((i = 0; i < ${#lines[@]}; i++)); do
    [[ "${lines[i]}" =~ $TRIED_LINE_RE ]] || continue
    [[ "${lines[i + 1]-}" =~ $LIST_ITEM_RE ]] || continue
    indent=${#BASH_REMATCH[1]}
    n=0
    for ((j = i + 1; j < ${#lines[@]}; j++)); do
      [[ "${lines[j]}" =~ $LIST_ITEM_RE ]] || break
      ((${#BASH_REMATCH[1]} < indent)) && break
      ((${#BASH_REMATCH[1]} == indent)) && n=$((n + 1))
    done
    ((n > best)) && best=$n
  done
  printf '%s' "$best"
}

human_rule() {
  cat <<EOF
\`takes:human\` means the next action happens OUTSIDE Claude Code ENTIRELY. It is picked from the next ACTION, never from the subject. Name the concrete outside act, one of the founder's own (#1077): $(acts_line). A website job no act on that list covers adds a **Tried:** list of at least $TRIED_MIN methods that failed.

Add the act to the body, on its own line:

  **Outside Claude Code:** <the act, in plain words>

IF YOU CANNOT WRITE THAT LINE HONESTLY, THE LABEL IS WRONG. Being barred is not the same as being impossible:

  - a skill's own scope barring THIS pass from the edit    → takes:implement
  - a repo rule barring an agent from the act              → takes:wayfinder, to rule on it
  - a command needing a password or a founder keystroke    → the founder types \`! <cmd>\` IN Claude Code; still not outside it
  - reading repo files and writing a ruling                → takes:wayfinder
  - a founder decision or confirmation                     → takes:wayfinder, where the founder makes it
  - applying a prescribed edit                             → takes:implement
  - an act whose product is a file in this repository     → takes:implement; the founder's review of it is takes:wayfinder

There is no "no command opens this" shape: a scripted tracker whose queue has emptied closes, or moves to the command that owns what is left (mantahostels#3352).

Rule: docs/agents/triage-labels.md §\`takes:\`, the nuances block (mantahostels#804, mantahostels#2775, mantahostels#3439, mantahostels#3555).
EOF
}

# $1 is the segment, $2 the verb phrase — "creates a \`takes:human\` issue" or
# "applies \`takes:human\` to #n".
deny_no_act() {
  local reason
  IFS= read -r -d '' reason <<EOF || :
This $2 whose body names no act performed outside Claude Code: @CMD@

$(human_rule)
EOF
  gp_deny "$reason" "$1"
}

# $1 is the segment, $2 the Outside line, $3 the verb phrase as deny_no_act's.
deny_repo_file() {
  local reason
  IFS= read -r -d '' reason <<EOF || :
This $3 whose outside act produces a file in this repository: @CMD@

  $2

An act that ends in a repo file is never an outside act, whatever tool a document names as the owner's (mantahostels#3503).

  - the file itself                              → takes:implement, and an agent writes it
  - the founder's taste on what the agent drew  → takes:wayfinder, a review in session

Relabel, and drop the tool and the path from the Outside line if a real outside act remains.

Rule: docs/agents/triage-labels.md §\`takes:\`, the nuances block (mantahostels#3555).
EOF
  gp_deny "$reason" "$1"
}

# $1 is the segment, $2 the Outside line, $3 the verb phrase as deny_no_act's.
deny_barred() {
  local reason
  IFS= read -r -d '' reason <<EOF || :
This $3 whose Outside line names a prohibition rather than an act: @CMD@

  $2

BEING BARRED IS NOT BEING IMPOSSIBLE (mantahostels#2775). The Outside line names what the founder DOES outside Claude Code, one of his own acts (#1077): $(acts_line).

Before relabelling, TEST the bar rather than restating it:

  - a file you believe unwritable   → \`test -w <path>\`; a home-directory file usually is
  - a rule you believe forbids it   → read the rule; most name a surface, not a filesystem
  - a command wanting a password    → the founder types \`! <cmd>\` IN Claude Code

If the bar is real, it is a repo rule and the issue is \`takes:wayfinder\`, to rule on it. If the bar is not real, the issue is \`takes:implement\`.

Rule: docs/agents/triage-labels.md §\`takes:\`, the nuances block (mantahostels#2775, #140).
EOF
  gp_deny "$reason" "$1"
}

# $1 is the segment, $2 the Outside line, $3 the verb phrase as deny_no_act's.
deny_not_founder_act() {
  local reason
  IFS= read -r -d '' reason <<EOF || :
This $3 whose Outside line names none of the founder's own acts: @CMD@

  $2

The acts are: $(acts_line).

Two ways out:

  - name the act from that list on the Outside line
  - or, for a website job no act on it covers, add a **Tried:** line followed directly by at least $TRIED_MIN list items, one per different method you actually ran and what it showed

Neither true means an agent can do it, and the label is wrong.

Rule: docs/agents/triage-labels.md §\`takes:\`, the nuances block (#1077, #1097).
EOF
  gp_deny "$reason" "$1"
}

DELIVERABLE_POINTER_LEAD="This applies takes:human. The issue body is the hand-over's source: the act, why, the deliverable verbatim or each step, then **Close when:**. The full rule:"
DELIVERABLE_RULE_FALLBACK="The founder-deliverable template could not be read from docs/agents/rules/founder-deliverable.txt. Read that file before doing anything else."

# $1 is the segment, $2 the verb phrase as deny_no_act's.
deny_no_close() {
  local reason
  IFS= read -r -d '' reason <<EOF || :
This $2 whose body has no **Close when:** line: @CMD@

Every founder errand says when it is finished (#983). Add it to the body, on its own line:

  **Close when:** <what finishes it> — and what the closing comment records, naming any issue that waits on the result

$(gp_rule_text founder-deliverable "$DELIVERABLE_RULE_FALLBACK")
EOF
  gp_deny "$reason" "$1"
}

# $2 is what is wrong with the body, completing "This files an issue whose body …".
deny_blank() {
  local reason
  IFS= read -r -d '' reason <<EOF || :
This files an issue whose body $2: @CMD@

gh files an issue from an absent or empty body file as a blank issue, and exits 0 (mantahostels#3443).

Write the body first. Either check the call that should have written the file really ran — a denied compound command writes nothing — or feed the body in this same command:

  cat <<'BODY' | gh issue create --title "…" --label takes:… --body-file -
  <the body>
  BODY

A command that writes the file itself before creating (\`cat > <path> <<'BODY'\`, \`tee <path>\`) is let through: the file's name appearing a second time on the command reads as that write.
EOF
  gp_deny "$reason" "$1"
}

# The blank-body limb (mantahostels#3443), for every takes: value. Runs before the label
# verdict, so a blank create is refused for the body even where its label is
# also wrong, and a takes:human one is never recorded as unreadable first.
judge_body() {
  [[ -n "$body_missing" ]] &&
    deny_blank "$1" "is read from a file that does not exist: \`$body_missing\`"
  ((body_given && !body_hidden)) || return 0
  [[ -n "${body//[[:space:]]/}" ]] || deny_blank "$1" "is empty"
  judge_basis "$1"
}

# Read by scripts/lib/issue-gate.js, which file-issue.js and issue-body.js share,
# so the three routes cannot disagree. Only a body this guard read is judged —
# the REST and GraphQL routes, and a hidden body, pass it unjudged. A missing
# node, or one outlasting its 5 seconds, fails open, recorded.
judge_basis() {
  local refusal rc reason
  refusal="$(printf '%s' "$body" | timeout 5 node "$here/lib/issue-gate.js" --basis-faults 2>/dev/null)"
  rc=$?
  ((rc == 0)) && return 0
  [[ -n "$refusal" ]] || {
    gl_log "lib/issue-gate.js --basis-faults gave no reading — basis unchecked on this create" "exit $rc"
    return 0
  }
  IFS= read -r -d '' reason <<EOF || :
This files an issue whose body sets a wait with nothing behind it: @CMD@

It carries $refusal

Ask of the window: what data sets it, and does anything shorter hold? Where the answer is a round figure, cut the window to what the data defends.
EOF
  gp_deny "$reason" "$1"
}

# The second-map limb (#717), read by scripts/lib/issue-gate.js, which
# file-issue.js shares. Only a create carrying wayfinder:map forks it, for its
# one `gh issue list`, run where the create runs so that, with no repo named,
# gh resolves the same one. $labels, $create_repo and $create_repo_hidden come
# from the caller's own locals — judge_create's or judge_api's (#1464).
judge_second_map() {
  local label is_map=0 cwd refusal rc reason
  for label in ${labels+"${labels[@]}"}; do
    [[ "$label" == wayfinder:map ]] && is_map=1
  done
  ((is_map)) || return 0
  ((create_repo_hidden)) && {
    gl_log "could not read which repo a wayfinder:map create files into — second map unchecked on this create"
    return 0
  }
  cwd="$(gp_cwd)"
  [[ -n "$cwd" || -n "$create_repo" ]] || {
    gl_log "could not tell which directory a wayfinder:map create runs in — second map unchecked on this create"
    return 0
  }
  # 9 is no exit issue-gate.js gives, so it can only be the cd.
  refusal="$(
    cd "${cwd:-.}" 2>/dev/null || exit 9
    timeout 4 node "$here/lib/issue-gate.js" --second-map ${create_repo:+"$create_repo"} 2>/dev/null
  )"
  rc=$?
  ((rc == 0)) && return 0
  ((rc == 9)) && {
    gl_log "could not enter the directory a wayfinder:map create runs in — second map unchecked on this create"
    return 0
  }
  ((rc == 1)) && [[ -n "$refusal" ]] || {
    gl_log "lib/issue-gate.js --second-map gave no reading — second map unchecked on this create" "exit $rc: $refusal"
    return 0
  }
  IFS= read -r -d '' reason <<EOF || :
This creates a second wayfinder map while the first is unfilled: @CMD@

$refusal
EOF
  gp_deny "$reason" "$1"
}

GRAPHQL_FIX='gh issue create --title "…" --body "…" --label takes:triage'

warning="" # held back in case a later segment denies

# The third tier (mantahostels#519), for the one route where the guard can see a creation
# but not its labels. $1 is the segment, $2 what it cannot tell.
warn_once() {
  [[ -n "$warning" ]] && return 0
  warning="This files a GitHub issue through GraphQL, and $2:

  $(gp_unmask "$1")

Every open issue carries exactly one \`takes:\` value, naming the command that opens it. Without one, /pick-next shows \`none\` in its TAKES column and nothing says who or what works the issue.

Confirm one of the seven is applied, or file it through the flag form, which the guard can read in full:

$(values_line)
  $GRAPHQL_FIX

Rule: docs/agents/triage-labels.md §\`takes:\`."
}

FLAG_FORM_COST="That is worse than a missing label. A \`gh issue create\` naming a label GitHub does not know ABORTS THE WHOLE CREATE AND STILL EXITS 0: nothing is filed, and the call reads as success."

API_FORM_COST="Whether GitHub creates the misspelt label or drops it, nothing downstream reads it: /pick-next shows \`none\` in its TAKES column, and the issue is as unroutable as one carrying no label at all."

# The verdict, given the labels a creation carries. The segment is $1; $labels,
# $route_cost and the fix's three parts — $route_fix, the command up to its
# labels, and $route_label_flag and $route_label_key, how it spells one — come
# from the caller's own locals. The fix shown carries `takes:triage` and then
# the command's own labels, each shell-quoted, so copying it keeps them.
#
# EVERY takes: word is checked, not just the first. gh aborts on any label it
# does not know, so `--label takes:implement --label takes:implememt` files
# nothing at exit 0 — a scan that stopped at the first valid value would wave
# through the exact failure this guard exists to make impossible.
judge_labels() {
  local label found="" valid=0 human=0
  for label in ${labels+"${labels[@]}"}; do
    [[ "$label" == takes:* ]] || continue
    found="${label#takes:}"
    is_valid "$found" || deny_invalid "$1" "$found" "$route_cost"
    [[ "$found" == human ]] && human=1
    valid=1
  done
  if ((valid)); then
    ((human)) && judge_human_body "$1"
    return 0
  fi
  local fix="$route_fix"
  for label in takes:triage ${labels+"${labels[@]}"}; do
    fix+=" $route_label_flag $(sp_shell_word "$route_label_key$label")"
  done
  deny_missing "$1" "$fix"
}

# $1 the segment, $2 what the command does wrong, $3 the refusing ticket's
# citation, bracketed so the release build qualifies it, $4
# the passing spelling — the two routes differ only there (#668, #669).
deny_unread_body() {
  local reason
  IFS= read -r -d '' reason <<EOF || :
This $2: @CMD@

A \`takes:human\` body must name its outside act, and a body the guard cannot read is one nobody checked $3. $4

$(human_rule)
EOF
  gp_deny "$reason" "$1"
}

deny_unread_human() {
  deny_unread_body "$1" 'creates a `takes:human` issue whose body this guard cannot read' '(#668)' "Re-spell it so the body is read, from a quoted heredoc:

  cat <<'BODY' | gh issue create --title \"…\" --label takes:human --body-file -
  <the body, with its **Outside Claude Code:** and **Close when:** lines>
  BODY"
}

# The `takes:human` limb (mantahostels#2775). Reached only where the create carries a VALID
# takes:human — a missing or misspelt label is the older, larger fault and is
# refused above, so a session never gets two refusals for one command.
#
# An unreadable body is REFUSED here, not failed open (#668): the quoted heredoc
# is a spelling this guard always reads, so every legitimate takes:human create
# has one that passes.
judge_human_body() {
  ((body_hidden)) && deny_unread_human "$1"
  judge_human_text "$1" "$body" 'creates a `takes:human` issue'
}

# $1 the segment, $2 the body, $3 the verb phrase for any of the five refusals.
judge_human_text() {
  local line
  [[ "$2" =~ $HUMAN_MARKER_RE ]] || deny_no_act "$1" "$3"
  [[ "$2" =~ $HUMAN_LINE_RE ]] && {
    line="${BASH_REMATCH[0]}"
    [[ "$line" =~ $BARRED_RE ]] && deny_barred "$1" "$line" "$3"
    [[ "$line" =~ $REPO_FILE_RE ]] && deny_repo_file "$1" "$line" "$3"
    is_founder_act "$line" || (($(tried_count "$2") >= TRIED_MIN)) ||
      deny_not_founder_act "$1" "$line" "$3"
  }
  [[ "$2" =~ $CLOSE_WHEN_RE ]] || deny_no_close "$1" "$3"
  human_applied=1
}

# `gh issue create …` — the flag form.
judge_create() {
  local segment="$1"
  shift
  local -a labels=()
  local unreadable="" helping=0 body="" body_hidden=0 body_given=0 body_missing="" body_fault=""
  local create_repo="" create_repo_hidden=0
  local route_cost="$FLAG_FORM_COST"
  local route_fix='gh issue create --title "…" --body "…"'
  local route_label_flag=--label route_label_key=""

  scan_create "$@"

  # `gh issue create --help` prints documentation and files nothing.
  ((helping)) && return 0

  [[ -n "$unreadable" ]] && {
    gl_open "$unreadable — create allowed unchecked"
    return 0
  }

  judge_body "$segment"
  judge_labels "$segment"
  judge_second_map "$segment"
  [[ -n "$body_fault" ]] && gl_open "$body_fault — create allowed unchecked"
  return 0
}

# `gh issue edit <n>… --add-label takes:human` — the edit route (mantahostels#3555). Every
# flag gh issue edit takes a value for, so a bare word is an issue number.
EDIT_VALUE_FLAGS="--add-assignee --add-label --add-project --remove-assignee \
--remove-label --remove-project -b --body -F --body-file -m --milestone \
-t --title -R --repo"

# One argument of a `gh issue edit`, as <kind> <name> <value>.
edit_arg() {
  case "$2" in
    --help | -h)
      helping=1
      return 1
      ;;
  esac
  case "$1" in
    opt) case "$2" in
      --add-label) push_label "$3" ;;
      --body | -b) gb_body "$3" ;;
      # The create's file readers are tuned to a create's command shape, so a
      # body from a file or stdin is hidden here, and refused below.
      --body-file | -F) body_given=1 body_hidden=1 ;;
    esac ;;
    arg)
      case "$3" in
        *'$'* | *'`'*) unreadable=1 ;;
        *) numbers+=("$3") ;;
      esac
      ;;
  esac
  return 0
}

# The number out of one bare word: digits, or the tail of an issue URL.
# Non-zero where it is neither.
issue_number_of() {
  local w="$1"
  w="${w%/}"
  [[ "$w" =~ ^[0-9]+$ ]] && {
    printf '%s' "$w"
    return 0
  }
  [[ "$w" =~ /issues/([0-9]+)$ ]] && {
    printf '%s' "${BASH_REMATCH[1]}"
    return 0
  }
  return 1
}

# The second-map limb's lib/issue-gate.js reads the same var through lib/gh.js.
gh_bin="${WFC_GH:-gh}"

# The body of one issue, off the network. Non-zero where it cannot be had,
# which the caller records rather than reads as "the line is absent".
fetch_body() {
  command -v "$gh_bin" >/dev/null 2>&1 || return 1
  timeout 3 "$gh_bin" issue view "$1" --json body --jq '.body // ""' 2>/dev/null
}

FETCH_CAP=2 # fetches a command may spend; the arithmetic is in the header

# Names only the relabel-alone spelling (#669): guard-issue-body.sh denies
# every `gh issue edit --body`, a readable one included.
deny_unread_relabel() {
  deny_unread_body "$1" 'applies `takes:human` while rewriting the body in a way this guard cannot read' '(#669)' "Write the line first, then relabel alone — the guard fetches the body the label lands on:

  node $(gp_script_path issue-body.js) append <n> --text \"**Outside Claude Code:** <the act, in plain words>\"
  node $(gp_script_path issue-body.js) append <n> --text \"**Close when:** <what finishes it>\"
  gh issue edit <n> --add-label takes:human"
}

judge_edit() {
  local segment="$1"
  shift
  local -a labels=() numbers=()
  local unreadable=0 helping=0 body="" body_hidden=0 body_given=0 body_missing=""
  local label human=0 n num text fetched=0
  local unread="could not read the issue number of a gh issue edit — takes:human relabel allowed unchecked"

  gp_scan_flags "$EDIT_VALUE_FLAGS" edit_arg -- "$@"
  ((helping)) && return 0

  for label in ${labels+"${labels[@]}"}; do
    [[ "$label" == takes:human ]] && human=1
  done
  ((human)) || return 0

  ((unreadable)) && {
    gl_open "$unread"
    return 0
  }

  # The edit writes the body in the same call, so that text is what the label
  # lands on — where it can be read.
  if ((body_given)); then
    ((body_hidden)) && deny_unread_relabel "$segment"
    judge_human_text "$segment" "$body" 'applies `takes:human` to #'"${numbers[0]-?}"
    return 0
  fi

  for n in ${numbers+"${numbers[@]}"}; do
    num="$(issue_number_of "$n")" || {
      gl_open "$unread"
      continue
    }
    ((fetched < FETCH_CAP)) || {
      gl_open "more than $FETCH_CAP issues on one takes:human relabel — #$num allowed unchecked"
      continue
    }
    ((fetched++))
    text="$(fetch_body "$num")" || {
      gl_open "could not fetch #$num's body for a takes:human relabel — relabel allowed unchecked"
      continue
    }
    judge_human_text "$segment" "$text" 'applies `takes:human` to #'"$num"
  done
}

# `gh api graphql` carrying a `createIssue` mutation — the third and last Bash
# spelling of a creation (mantahostels#519). The query text is read back out of the span the
# parser blanked by lib/guard-gh-api.sh, shared with guard-issue-body.sh, which
# chases the `updateIssue` mutation the same way (mantahostels#284).
#
# WHY THIS ROUTE IS THE WEAKEST OF THE THREE: GraphQL takes label NODE IDS
# (`LA_kwDO…`), not names. So where a mutation carries labelIds the guard cannot
# tell whether any of them is a `takes:` value, and there is no reading of the
# command that would tell it. That splits the verdict:
#   no labelIds at all   the issue is filed with no labels whatever, read off
#                        the command and not inferred           → DENY
#   labelIds present     opaque ids, or a variable holding them → WARN
#   input passed whole   the mutation names no field at all     → WARN
judge_graphql() {
  local segment="$1" args

  ga_scan_graphql

  # No `createIssue` in the query text: nothing is filed, as far as this guard
  # can read. Where that text was unreadable the mutation may be in the part it
  # cannot see, and that is left in silence — see LIMITS.
  args="$(ga_mutation_args createIssue)" || return 0

  # Some of the query is out of sight, so a labelIds could be sitting in it.
  if ((api_query_hidden || api_opaque || api_input)); then
    warn_once "$segment" "part of the query is out of sight, so the guard cannot see whether it applies a label"
    return 0
  fi

  # ga_mutation_args stops at the FIRST `)`, so a bracket inside a string
  # literal — `title:"fix (again)"` — cuts the arguments short and a trailing
  # `labelIds` falls off the end with it. DENYING ON A TRUNCATED READ WOULD
  # REFUSE A CORRECTLY-LABELLED CREATION. An odd number of quote marks is the
  # mark of a literal the cut ran through, so it drops to the warn tier.
  #
  # It does not read to the matching bracket: the whitespace squash
  # above has already rewritten the inside of every string literal, so this
  # cannot become a faithful parse — only a less obviously wrong one.
  local quotes="${args//[^\"]/}"
  if ((${#quotes} % 2)); then
    warn_once "$segment" "a bracket inside a string literal cut the mutation's arguments short, so the guard cannot see whether a label follows it"
    return 0
  fi

  case "$args" in
    # The whole input object arrives as one variable, so the mutation names no
    # field at all. A variable INSIDE a braced input is different: every field
    # name is still spelled out there, so a labelIds could not hide in one.
    *'input:$'*)
      warn_once "$segment" "the mutation's input arrives whole as a variable, so the guard can see no field names at all"
      return 0
      ;;
    # An empty list applies no label, so it is the missing-label case spelled long.
    *labelIds:'[]'*) ;;
    *labelIds:*)
      warn_once "$segment" "GraphQL takes label NODE IDS rather than names, so nothing on the command says whether any of these \`labelIds\` is a \`takes:\` value"
      return 0
      ;;
  esac

  deny_missing "$segment" "$GRAPHQL_FIX"
}

# `gh api … repos/<o>/<r>/issues` — the same creation through the REST endpoint
# (mantahostels#511). The method, endpoint and fields are read by lib/guard-gh-api.sh, shared
# with guard-issue-body.sh, which chases the PATCH spelling (mantahostels#132).
judge_api() {
  local segment="$1"
  shift
  local -a api_fields=() labels=()
  local api_method="" api_endpoint="" api_opaque=0 api_input=0
  local api_query="" api_query_hidden=0 # ga_scan_graphql's outputs
  local method_hidden=0 endpoint_hidden=0 unreadable=0 field text
  local method="" endpoint="" body="" body_hidden=0
  local create_repo="" create_repo_hidden=0 # judge_second_map's inputs
  local route_cost="$API_FORM_COST"
  local route_fix="gh api --method POST repos/<owner>/<repo>/issues -f title=…"
  local route_label_flag=-f route_label_key="labels[]="

  ga_scan_api "$@"

  # The method and the endpoint are READ BACK, not merely inspected: the splitter
  # blanks every quoted span, so judging the blanked word would let a pair of
  # quotes around `repos/o/r/issues` walk the creation past the deny.
  method="$(gp_literal "$api_method")" || method_hidden=1
  endpoint="$(gp_literal "$api_endpoint")" || endpoint_hidden=1

  # Either word, read and plainly not a creation, ends the segment whatever the
  # other one says — so an unreadable endpoint on a GET, or an unreadable method
  # on a call aimed elsewhere, records nothing.
  if ((!method_hidden)); then
    if [[ -z "$method" ]]; then
      # gh's own default is POST where the call carries a payload and GET where
      # it does not, so `gh api repos/o/r/issues -f title=x` files an issue with
      # the word POST nowhere on the command.
      ga_defaults_to_post || return 0
    elif [[ "${method^^}" != "POST" ]]; then
      return 0
    fi
  fi

  # GraphQL puts what it writes in the query text rather than in the endpoint,
  # so it is judged before the REST test below, which would read it as neither a
  # creation nor anything else and return.
  if ((!endpoint_hidden)) && ga_is_graphql_endpoint "$endpoint"; then
    judge_graphql "$segment"
    return 0
  fi

  # The COLLECTION, never one issue: a POST to `…/issues/<n>/comments` or
  # `…/dependencies/blocked_by` creates something that takes no label at all.
  ((endpoint_hidden)) || ga_is_issue_collection_endpoint "$endpoint" || return 0
  if ((!endpoint_hidden)); then
    create_repo="$(ga_endpoint_repo "$endpoint")" || create_repo_hidden=1
  fi

  # $api_opaque is deliberately not consulted: a masked field name is still
  # legible to gp_literal below, which is where every field name is read.
  ((method_hidden || endpoint_hidden || api_input)) &&
    gl_open "could not read a gh api issue creation — create allowed unchecked"

  # THE FIELD NAME DECIDES, never the value. `-f title="$T"` is the ordinary way
  # to pass a title, and gp_literal fails on the whole word for the one `$` in
  # it — so failing open there would disarm the deny on almost every real
  # creation. The value is only read where the name says it is the labels.
  for field in ${api_fields+"${api_fields[@]}"}; do
    text="$(gp_literal "$field")"
    unreadable=$?
    case "${text%%=*}" in
      *'$'* | *'`'* | *"$QUOTED"*)
        gl_open "could not read a field name on a gh api issue creation — create allowed unchecked"
        ;;
    esac
    # `labels[]=` is gh's array spelling and the one the endpoint wants; the bare
    # name is judged too, so a caller who got the array syntax wrong is told
    # about the label rather than about the syntax.
    case "$text" in
      "labels[]="*) labels+=("${text#"labels[]="}") ;;
      labels=*) labels+=("${text#labels=}") ;;
      # The body, for the takes:human limb. `@file` is gh's read-from-disk
      # spelling on -F, and what follows it is a path rather than the text.
      body=*)
        if ((unreadable)) || [[ "${text#body=}" == @* ]]; then
          body_hidden=1
        else
          body+="${text#body=}"
        fi
        continue
        ;;
      *) continue ;;
    esac
    ((unreadable)) &&
      gl_open "could not read a labels field on a gh api issue creation — create allowed unchecked"
  done

  judge_labels "$segment"

  # An unreadable endpoint was recorded above.
  ((endpoint_hidden)) && return 0
  judge_second_map "$segment"
}

# Called once per command the tool call runs, with the segment as $1 and the
# command's own words — environment assignments already stripped — as $2 onward.
judge() {
  local segment="$1"
  shift

  [[ "$(basename "$1")" == "gh" ]] || return 0

  case "${2-}" in
    issue) case "${3-}" in
      create) judge_create "$segment" "${@:4}" ;;
      edit) judge_edit "$segment" "${@:4}" ;;
    esac ;;
    api) judge_api "$segment" "${@:3}" ;;
  esac
}

human_applied=0
gp_walk_commands judge

# A pointer, not the fragment: its 1.8 KB through gp_rule put the Bash tool over
# route (f)'s cap (docs/doc-map.md §Capture and placement).
if ((human_applied)); then
  [[ -n "$warning" ]] && warning+=$'\n\n'
  warning+="$DELIVERABLE_POINTER_LEAD $(gp_script_path lib/rule-text.sh) founder-deliverable"
fi

[[ -n "$warning" ]] && gp_warn "$warning"

gp_allow
