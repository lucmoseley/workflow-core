#!/usr/bin/env bash
# inject-tracker-docs.sh — hand the issue-tracker rules to the session that is
# about to create issues.
#
# WHAT IT INJECTS IS RULES, NOT DOCUMENTS: prose held in this file, so a renamed
# or unreadable document cannot empty the payload. Nothing under the REPO is
# read to build it but one path from .claude/workflow-core.json, the output
# style (#448) — the job record and the de-duplication marker are.
#
# Each of its two events reads the command its own way:
#   UserPromptSubmit — the command typed in a live session
#   SessionStart     — a background job launched with the command as its
#                      opening prompt, so no prompt is ever "submitted"; the
#                      text is read from the job record's `intent` instead —
#                      a race against the daemon writing it, which CLIs before
#                      2.1.241 mostly lose, so UserPromptSubmit is what carries
#                      them (mantahostels#1142; scripts/measure-sessionstart-intent/).
#
# LIMITS — this fires on the named slash commands only. An ad-hoc "open an issue
# for X" typed in prose gets nothing, and cannot: that path has no distinguishing
# shape.
#
# Never blocks. Missing jq, unreadable payload, no command matched — every path
# exits 0 and injects nothing.
#
# Because both events are wired, a background job whose opening prompt names a
# command fires both wherever `intent` was written in time, injecting the same
# payload twice. The de-duplication block below drops the second (mantahostels#1117);
# a genuine re-invocation of the same command later still injects.
#
# IMPLICIT:  pastes the tracker overrides and the priced-options shape (a pointer to it where Core voice loads, #2039), and hands each of the seven tracker commands its own residue index of rule ids (mantahostels#2499), and names an issue whose `takes:` label is another command's (#1164), into the context of that command, at UserPromptSubmit and SessionStart, without the session asking.
# JUSTIFIED: fail-safe — the rules' own home is not auto-loaded, and the vendored skills carry them only by a per-skill declared edit (mantahostels#1826), so an uninjected session follows the vendored instructions instead.
# DEFEAT:    none — injection is keyed to the command's shape and nothing suppresses it.

set -uo pipefail

# Commands that read or write the tracker. `card-close` is project-owned
# (.claude/skills/card-close/); the rest are vendored skills.
#
# `code-review` is here for the disposition rule and the standards pointer
# (mantahostels#185, mantahostels#1011).
#
# KEEP IT ONE UNQUOTED LINE AT COLUMN ZERO. check-injector-margin.sh reads this
# array with `sed` to know which commands to measure (mantahostels#1915): a multi-line array
# or a trailing comment makes it BROKEN and refuses the commit, and QUOTED
# elements are worse — the quotes reach the match, no command matches, and the
# refusal blames the command rather than this line.
COMMANDS=(wayfinder to-spec to-tickets implement triage card-close code-review)

# Docs pasted in full. EMPTY (mantahostels#1870), and deliberately declared:
# check-context-budget.js parses this array to know what the injector adds to a
# session's context, and treats a missing array as a BROKEN gate rather than as
# nothing injected.
#
# Every command lands as ONE wired entry — mantahostels#1869 ruled against
# splitting a payload across several, which both parsers of this file would
# under-count.
#
# WHAT STAYS PASTED is the rule-by-rule call mantahostels#1870 made, on one test: would a
# session that never reads the tracker documents do the WRONG thing, or merely an
# UNINFORMED one? Pasted where the vendored skill's own default is actively
# wrong — the header's three overrides, the research-dispatch clause, the
# priced-options shape, the per-command blocks. Indexed (mantahostels#2499) where a
# miss is uninformed and has no observable `gh` shape; still caught by a
# guard's denial where one exists.
# shellcheck disable=SC2034  # read by check-context-budget.js, not by this script
DOCS=()

payload="$(cat 2>/dev/null || true)"

command -v jq >/dev/null 2>&1 || exit 0
jqr() { printf '%s' "$payload" | jq -r "$1" 2>/dev/null || true; }

# A subagent's payload names its parent's session, whose command is not the
# subagent's (#1785).
# shellcheck source=scripts/lib/subagent-payload.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/subagent-payload.sh" 2>/dev/null &&
  is_subagent_payload "$payload" && exit 0

prompt="$(jqr '.prompt // ""')"
event="$(jqr '.hook_event_name // ""')"

# SessionStart carries no prompt. A background job's opening prompt is recorded
# on the job as `intent`, which is where the command will be if this is one of
# those sessions. Interactive SessionStart has neither, and correctly no-ops.
if [[ -z "$prompt" && -n "${CLAUDE_JOB_DIR:-}" && -f "$CLAUDE_JOB_DIR/state.json" ]]; then
  prompt="$(jq -r '.intent // .detail // ""' "$CLAUDE_JOB_DIR/state.json" 2>/dev/null || true)"
fi

[[ -z "$prompt" ]] && exit 0

# Hand $1 to the session. Both wired events read plain stdout as context too.
#
# The pair can land inside one hook process's own runtime (mantahostels#1117), so the check
# further down is an early exit only: creating the marker with O_EXCL is what
# makes exactly one firing the winner, and the loser returns having printed
# nothing. Reserving in emit rather than at that check means a firing that
# produced no text reserves nothing, so the next one still injects — except the
# /code-review arm, which reserves before it runs the review-tier hook.
#
# reserve is spent on success, so emit does not take it twice.
reserve() {
  [[ -n "$marker" ]] || return 0
  # noclobber makes `>` refuse an existing file at the open(2), so two
  # processes cannot both succeed. An aged-out marker was already removed by
  # the check below, so losing here means a live duplicate, not a stale file.
  set -o noclobber
  if ! { printf '%s' "$takes_issue" >"$marker"; } 2>/dev/null; then
    set +o noclobber
    return 1
  fi
  set +o noclobber
  # Markers would otherwise accumulate for the life of the host. Any threshold
  # above the window is correct: one older than 60 s can no longer suppress
  # anything.
  find "$state_dir" -maxdepth 1 -type f -mmin +1440 -delete 2>/dev/null
  marker=""
}

emit() {
  local out
  # The text names core scripts as `scripts/x`; an install serves them through
  # the plugin root (#343).
  declare -F resolve_script_paths >/dev/null && set -- "$(printf '%s' "$1" | resolve_script_paths)"
  case "$event" in
    UserPromptSubmit | SessionStart)
      out="$(jq -nc --arg e "$event" --arg c "$1" \
        '{hookSpecificOutput: {hookEventName: $e, additionalContext: $c}}' 2>/dev/null)" || out=""
      ;;
    *) out="$1" ;;
  esac
  [[ -n "$out" ]] || return 0
  reserve || return 0
  printf '%s\n' "$out"
}

# Cheap gate first: this runs on every prompt, so it stays a string match.
matched=""
matched_arg=""
matched_ns=""
for cmd in "${COMMANDS[@]}"; do
  # THE PLUGIN NAMESPACE IS OPTIONAL (#201) — in an adopter the command arrives
  # as `/workflow-core:wayfinder`, and a miss here drops the ENTIRE payload
  # silently. name-issue-session.sh carries a copy of this regex.
  #
  # Any word is accepted as the prefix rather than the literal `workflow-core`,
  # which is the PLUGIN's name, set in plugin.json by whoever ships it.
  #
  # RESIDUAL: a plugin naming itself with a `.` or an `@` is outside this
  # character class and matches nothing, silently.
  re="(^|[[:space:]])/([A-Za-z0-9_-]+:)?${cmd}([[:space:]]|\$)"
  if [[ "$prompt" =~ $re ]]; then
    matched="$cmd"
    matched_ns="${BASH_REMATCH[2]}"
    matched_arg="${prompt#*"${BASH_REMATCH[0]}"}"
    break
  fi
done

[[ -z "$matched" ]] && exit 0

# A command typed on an issue whose `takes:` label names another (#1164). The
# `gh` read sits below the de-duplication. Only the first issue reference is
# read, split from the rest as name-issue-session.sh splits them — keep the two
# in step. /triage and /card-close open any issue, and /code-review takes none.
# A `takes:` value that is itself in COMMANDS names that command, so the
# vocabulary (scripts/lib/takes-label.js's TAKES_VALUES) is never copied here.
# No reference, no `takes:` label, or a `gh` that fails or outruns
# TAKES_GH_TIMEOUT_S (the hook's 10 s overrun would drop the whole payload) adds
# nothing. 4 is a guess, leaving the rest of the hook 6 s; WFC_TAKES_GH_TIMEOUT_S
# shortens it for a test only (#2268).
TAKES_GH_TIMEOUT_S=4
takes_issue=""
takes_repo=""
case "$matched" in
  wayfinder | to-spec | to-tickets | implement)
    token="${matched_arg#"${matched_arg%%[![:space:],&+]*}"}"
    token="${token%%[[:space:],&+]*}"
    token="${token%[.,;:]}"
    if [[ "$token" =~ ^https?://github\.com/([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)/issues/([0-9]+)([/?#].*)?$ ]]; then
      takes_repo="${BASH_REMATCH[1]}"
      takes_issue="${BASH_REMATCH[2]}"
    elif [[ "$token" =~ ^#?([0-9]+)$ ]]; then
      takes_issue="${BASH_REMATCH[1]}"
    fi
    ;;
esac

# The pair this drops: SessionStart reads the command off the job record's
# `intent`, then the same text arrives as a submitted prompt
# (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/tracker-injection-frequency.md, mantahostels#1083).
#
# The key is the SESSION and the COMMAND, not the prompt: the payload is a
# function of which command matched and of the first issue's `takes:` label.
# The marker holds that issue's number, and a firing naming another issue is
# no duplicate (#1164).
#
# Every failure path below INJECTS: under-injecting silently drops the tracker
# rules, which mantahostels#645, mantahostels#646, mantahostels#702 and mantahostels#706 exist to prevent.
#
# **Residuals.** (1) Two session ids differing only in a character the sanitiser
# strips share one marker, so the second session's firing reads as the first's
# duplicate and is dropped. Unobserved: the ids in this corpus are uuids.
# (2) Only the window discriminates within a source, so a session that really
# does re-invoke the same command inside 60 s gets no second copy.
DEDUPE_WINDOW=60

session="$(jqr '.session_id // ""')"
[[ -n "$session" ]] || session="${CLAUDE_CODE_SESSION_ID:-}"

# Scratch state, but not this script's alone (mantahostels#2769):
# concision-backstop.sh reads the `.implement` marker at Stop to decide whether a
# session's code-review floor is 20 changed lines or none, so this name, its
# sanitiser, the compact/clear/resume exclusion below and the 24-hour sweep above
# all decide whether a review is demanded. Only concision-backstop.test.ts's
# "reads the marker inject-tracker-docs.sh actually writes" pins the path — the
# lifecycle is pinned by nothing, and loosening it silently restores the floor.
#
# It is keyed per session outside the repo.
# The session id reaches the filesystem as a path segment, so anything that is
# not a plain identifier is stripped rather than trusted as one. The directory
# is suffixed with the uid: a fixed path under a shared /tmp is one another
# account can have created first, and the sweep runs inside it.
state_dir=""
marker=""
if [[ -n "$session" ]]; then
  state_dir="${TMPDIR:-/tmp}/wfc-tracker-inject-${UID:-0}"
  mkdir -p "$state_dir" 2>/dev/null &&
    marker="$state_dir/${session//[^A-Za-z0-9_-]/_}.${matched}"
fi

# A SessionStart that is not a startup is a session whose context was cleared or
# summarised away, so it does NOT still hold the payload — suppressing there
# would drop the tracker rules at the one moment they had just been lost. Only a
# genuine startup can be half of the pair this block exists for.
case "$(jqr '.source // ""')" in
  compact | clear | resume) marker="" ;;
esac

# A clock that will not answer disables the de-duplication rather than reading
# every marker as recent, which would suppress every firing for the life of the
# session. Same footing for a marker dated AHEAD of now — a WSL2 guest clock
# stepping back after a host suspend — which an unsigned reading of the window
# would treat as recent forever.
now="$(date +%s 2>/dev/null)"
[[ "$now" =~ ^[0-9]+$ ]] || now=""

# Cheap early exit for the ordinary case, where the pair is dispatched in order.
# A marker whose age cannot be read at all disables the de-duplication instead of
# being trusted either way: left in place it would win the reservation above and
# the session would get nothing.
if [[ -n "$marker" && -f "$marker" ]]; then
  stamp=""
  [[ -n "$now" ]] && stamp="$(stat -c %Y "$marker" 2>/dev/null || true)"
  if [[ "$stamp" =~ ^[0-9]+$ ]]; then
    ((stamp <= now && now - stamp < DEDUPE_WINDOW)) &&
      [[ "$(cat "$marker" 2>/dev/null)" == "$takes_issue" ]] && exit 0
    rm -f "$marker" 2>/dev/null || marker=""
  else
    marker=""
  fi
fi

fetch_takes_label() {
  local cwd repo_args=()
  cwd="$(jqr '.cwd // ""')"
  [[ -z "$cwd" ]] || cd "$cwd" 2>/dev/null || return 0
  [[ -n "$takes_repo" ]] && repo_args=(--repo "$takes_repo")
  timeout "${WFC_TAKES_GH_TIMEOUT_S:-$TAKES_GH_TIMEOUT_S}" "${WFC_GH:-gh}" issue view "$takes_issue" "${repo_args[@]}" --json labels \
    -q '[.labels[].name | select(startswith("takes:"))][0] // ""' 2>/dev/null
}
other_takes=""
[[ -n "$takes_issue" ]] && other_takes="$(fetch_takes_label)"
other_takes="${other_takes#takes:}"
[[ "$other_takes" == "$matched" ]] && other_takes=""

# The vendored code-review skill does not name how to dispatch its two axes.
# Named here so a review runs both axes in parallel rather than one
# after the other in a single context.
#
# THESE REACH A TYPED /code-review ONLY. A review loaded through the Skill tool —
# /implement's closing step — takes the same rules from scripts/lib/review-rules.js
# at that call (mantahostels#3451), as docs/agents/rules/review-*.txt. Keep the two in step.

# The Standards axis has no repo-specific rules unless it is handed the paths
# (mantahostels#992): the base at the resolved core root and the host's local
# file, in four states (#886, #965). scripts/concision-backstop.sh carries the
# same four texts for the sessions neither command reaches, and its test fails
# where the two differ (#2097).
# The literal path default and the both-state text, last, are what
# check-context-budget.js measures: it cannot evaluate a command substitution.
# The default is for an unresolved core root, spelt here and not in
# lib/review-standards.sh because this file's text leaves through an emitter
# that resolves a doc path, as the lib's does not (script-path-scan.test.ts).
# shellcheck source=scripts/lib/review-standards.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/review-standards.sh" 2>/dev/null
standards_base="docs/code-standards-base.md"
base_shown="$(review_standards_base_shown 2>/dev/null)" && standards_base="$base_shown"
standards_state="$(review_standards_state 2>/dev/null)" || standards_state=both
if [[ "$standards_state" == base ]]; then
  standards="Hand the Standards axis the base \`${standards_base}\` in its prompt; its §0 routes the paths. No local \`docs/code-standards.md\` exists, so its report opens \`No local standards file: the base applies unchanged.\`, or \`Base unreadable: <path>\` if its Read of the base is refused. Cite a breach by its rule id; never restate a rule tooling enforces."
elif [[ "$standards_state" == local ]]; then
  standards="The standards base \`${standards_base}\` is absent: hand the Standards axis only the local \`docs/code-standards.md\` in its prompt, never raising a smell its \"Smells not raised\" (or \"Suppressions\") names. It reviews against that file and the smell baseline, and its report opens \`No standards base: ${standards_base} is absent.\` Cite a breach by its rule id; never restate a rule tooling enforces."
elif [[ "$standards_state" == neither ]]; then
  standards="This repo has neither the standards base \`${standards_base}\` nor a local \`docs/code-standards.md\`: hand the Standards axis neither. Tell it in its prompt to review against the smell baseline and any other standards source the skill's step 3 found, its report opening \`No standards base or local file: ${standards_base} and docs/code-standards.md are absent.\`"
else
  standards="Hand the Standards axis, in its prompt, base \`${standards_base}\` and local \`docs/code-standards.md\`. Base §0 routes the paths; a local change binds only via its changes table, cited \"§X2 (base), excepted by local row 2\", and no local \"Smells not raised\" (or \"Suppressions\") smell is raised. A refused base Read opens the report \`Base unreadable: <path>\`. Cite a breach by its rule id; never restate a rule tooling enforces."
fi
# Base §G8 binds names to the host's glossary terms, so the axis gets the
# glossary where one exists (#1373). Spelled out rather than taken from
# review_standards_glossary_line, which the other two writers use, because
# check-context-budget.js measures only literal text, and the literal default
# here; concision-backstop.test.ts fails where the two differ (#2097).
glossary="GLOSSARY.md"
if glossary="$(review_standards_glossary 2>/dev/null)"; then
  glossary="$(review_standards_shown "$glossary")"
  standards="${standards} Hand the Standards axis \`${glossary}\` too, for base §G8."
fi

# The two review-axis Artefact paths are suffixed with THIS session's id so
# concurrent /code-review dispatches land on different files rather than one
# session's review overwriting a neighbour's (mantahostels#2220). Interpolated here, by the
# script, because a Write/Edit the SUBAGENT makes expands no environment
# variable (mantahostels#2088) — the literal path has to already be in the text the Agent
# call hands it. Falls back to the bare name — reinstating the exact collision
# mantahostels#2220 fixed — where no session id is available, or where lib/review-suffix.sh
# did not load.
# shellcheck source=scripts/lib/review-suffix.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/review-suffix.sh" 2>/dev/null
# shellcheck source=scripts/lib/script-path.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/script-path.sh" 2>/dev/null
# The empty default is the value scripts/check-context-budget.js measures: it
# cannot evaluate the command substitution, and without it BROKENs $dispatch.
sid_suffix=""
sid_suffix="$(review_suffix "$session" 2>/dev/null)"
# The core's bare `code-reviewer` or an adopter's plugin spelling (#741). The
# literal default is what check-context-budget.js measures, as above.
# shellcheck source=scripts/lib/review-agent-type.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/review-agent-type.sh" 2>/dev/null
review_type="workflow-core:code-reviewer"
review_type="$(review_agent_type 2>/dev/null)" || review_type="workflow-core:code-reviewer"

# The host's declared output style, which the priced-options text points at
# (#448) — core-voice.md where undeclared, or where lib/wfc-config.sh did not
# load. The literal default is what check-context-budget.js measures, as above.
# shellcheck source=scripts/lib/wfc-config.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/wfc-config.sh" 2>/dev/null
output_style=".claude/output-styles/core-voice.md"
style_read="$(wfc_output_style 2>/dev/null)" && output_style="$style_read"

# The dispatch rule is docs/agents/rules/review-dispatch-shape.txt, the one copy
# scripts/lib/review-rules.js and scripts/concision-backstop.sh print too
# (#1697). It names the subagent type and Artefact paths as "named above", so
# they lead. check-context-budget.js reads this one `rule_text` spelling as the
# fragment's text; any other is unparsed. So the load, fallback and lead-in are
# repeated in concision-backstop.sh rather than shared: it would count a
# helper's output as zero.
# shellcheck source=scripts/lib/rule-text.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/rule-text.sh" 2>/dev/null
dispatch_shape="$(rule_text review-dispatch-shape 2>/dev/null)"
[[ -n "$dispatch_shape" ]] || dispatch_shape="Dispatch the review runs as docs/agents/rules/review-dispatch-shape.txt says."
dispatch="Reviewer type \`${review_type}\`; Artefact paths \`.claude/tmp/review-standards${sid_suffix}.md\` and \`.claude/tmp/review-spec${sid_suffix}.md\`. ${dispatch_shape}"

# The ultrareview axis (mantahostels#834; ask-then-run, #1572, #1623). A pointer to
# the guide's steps, where docs/agents/rules/review-ultra-axis.txt carries them,
# because the injected docs' cap has no room for them. Deliberately NOT folded into $dispatch, which is
# restated verbatim in scripts/concision-backstop.sh's nag: that nag fires
# BEFORE a review, where this line has nothing to say.
ultra="AFTER fixing the findings, before the shared-tree commit, judge this diff against \`docs/effort-guide.md\` §The fourth axis; failing its test, the normal case, say NOTHING, and meeting it, follow that section's steps. NEVER START ONE UNASKED."

# The deviations record (mantahostels#1242), the half the REVIEWER needs. RE-CLASSIFY, NOT
# SUPPRESS: a documented deviation is never a decision the reviewer should not
# flag (mantahostels#1163) — a deviation note is the builder asserting its own
# intent, and an author judging its own output is not a pass.
deviations_read="$(rule_text review-deviations-read 2>/dev/null)"
[[ -n "$deviations_read" ]] || deviations_read="Fetch the originating issue's \`**Deviations:**\` comment for the Spec axis, as docs/agents/rules/review-deviations-read.txt says."

# The disposition rule (mantahostels#185): the code-review skill ends at "aggregate the
# findings" and names no destination for one.
disposition="$(rule_text review-finding-destination 2>/dev/null)"
[[ -n "$disposition" ]] || disposition="Give every review finding a destination, as docs/agents/rules/review-finding-destination.txt says."

# Every one of these commands can put a choice to the founder, and the vendored
# skills defer to `grilling`, which fixes the shape of the QUESTION and says
# nothing about the OPTIONS inside one — which pulls toward an unpriced menu. The
# pricing rule exists in the host's output style and in the founder's memory, but
# neither fires on a turn that presents as asking a question rather than making a
# claim. mantahostels#1503 scoped the lettered form to a round, so the clause below routes a
# real choice INTO one rather than letting it arrive unlettered. Do not reword the lettered
# shape below: it is the founder's own, and the wording is the requirement. The
# opening scope — the house decision a resolution or fork turns on, never every
# resolution — is #1752's, the sum-to-100 sentence answers #38, and the
# no-stakes-threshold sentence mantahostels#570.
priced_options_whole=$'\n\n'"EVERY CHOICE PUT TO THE FOUNDER SHIPS PRICED OPTIONS — each house decision a resolution or mid-session fork turns on. Enumerate the real alternatives (not motives, not diagnoses) and price each on its own line in exactly this shape, with nothing added:"$'\n\n'"(A) <the option, stated in plain words>"$'\n'"Confidence: 70% (60% - 80%). <what drives the estimate, and what would move it>"$'\n\n'"(B) <the next option>"$'\n'"Confidence: 30% (20% - 40%). <as above>"$'\n\n'"Relation: <rivals: which options actually conflict, and on what — or: independent, so any combination is takeable>"$'\n\n'"Options are ALWAYS lettered (A), (B), (C) — never numbered, never bulleted, never unlabelled — and the letter is what the founder replies with, so it is repeated in full wherever the option is referred to again. A choice put to the founder is put AS a numbered \`❓ **Q1**\` round, because the lettered priced form is owed inside a round (${output_style}); an ordinary question that is NOT a choice between alternatives is asked plainly instead, with one confidence figure and a recommendation, and takes no letters. The \`grilling\` skill's round shape governs the QUESTIONS you ask; the options inside any one question still take the lettered priced form here. Wherever there is more than one option the \`Relation:\` line is required, because the lettered shape reads as a ballot — rivals for one slot — and options that could be taken together must say so. THE FIGURES MEAN DIFFERENT THINGS BY RELATION: where the options are rivals for one slot, each figure is the probability that option is the right choice, so the headline figures sum to 100% (as 70% and 30% above) and the \`Relation:\` line says \`rivals\`; where options can be combined, each figure is that option's own chance of being worth taking and they need not sum. Then name the recommendation by its letter, every letter it takes where more than one is takeable, and the one assumption that would flip it. NO tables, NO horizontal rules, NO bold or titled option names. Never emit a filler percentage, and where a claim cannot be grounded say it is unknowable or subjective instead of inventing one. THE RULE HAS NO STAKES THRESHOLD: a choice that looks like a formality — a yes/no follow-on, a lopsided binary with one obvious answer — still ships the lettered priced form ((A) yes at ~90% is right; no options at all is not), and the only escape is saying a number is unknowable, never omitting the pricing. Research before you ask, as far as any source could answer it; ask only what research leaves open, naming that gap: \`rule:house-decision\`."

# Core voice carries the shape itself, so a session it loads into gets a pointer
# rather than a second copy (#2039). Where lib/wfc-config.sh did not load, the
# whole shape goes. check-context-budget.js measures the pointer, being the last
# `priced_options=` line; the whole shape's bound is the per-command
# persistence test in inject-tracker-docs.test.ts.
priced_options=$'\n\n'"EVERY CHOICE PUT TO THE FOUNDER SHIPS PRICED OPTIONS, in the lettered shape your Core voice output style gives, put as a numbered \`❓ **Q1**\` round. Research before you ask, and ask only what research leaves open, naming that gap: \`rule:house-decision\`."
wfc_core_voice_loaded 2>/dev/null || priced_options="$priced_options_whole"

# /code-review takes that rule ALONE, not the docs below: it files an issue only
# where a finding needs one, so the placement and labelling rules would cost far
# more context than the one rule it is missing.
#
# The review tier a declared sensitive path owes (#1697): the dispatcher's
# inject-review-tier core fires on the Skill tool alone, so it is run here,
# alone (`guard-dispatch.js --only`), on the payload that call would carry. It
# latches its rules as told, so the marker is reserved first and a losing
# duplicate never runs it. Its rules are capped at RULE_CAP and
# its areas prelude is not: where the whole would cross the harness's
# persistence threshold, HOOK_PERSIST_CHARS, the tier leads, so it lands in the
# preview. WFC_REVIEW_TIER_HOOK, the entry it is run through, is the test seam,
# as WFC_GH is for the `takes:` read.
#
# A bare typed name goes namespaced: the tier core passes over a bare
# `code-review` where the host has no local skill, as lib/review-rules.js
# refuses that Skill call (#1165), but a typed command is never refused (#1746).
# Any prefix but `code-review:` serves, as the tier core matches the rest of
# `*:code-review`, so a renamed plugin still gets its tier.
#
# The hook's 10 s (self-plugin/hooks/hooks.json, hooks/hooks.json) less 2 for the rest
# of this arm, a margin judged, not measured. A kill skips the core's own
# fail-open record, so it is recorded here.
TIER_HOOK_TIMEOUT_S=8
# The cwd rides too: the tier core reads a worktree the session works in from it
# (#2386).
skill_call() {
  jq -nc --arg s "$session" --arg k "${matched_ns:-workflow-core:}code-review" --arg c "$1" \
    '{hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: {skill: $k}, session_id: $s, cwd: $c}'
}
review_tier() {
  local hook cwd out rc
  hook="${WFC_REVIEW_TIER_HOOK:-$(dirname "${BASH_SOURCE[0]}")/guard-dispatch.js}"
  [[ -f "$hook" ]] || return 0
  cwd="$(jqr '.cwd // ""')"
  out="$(skill_call "$cwd" 2>/dev/null |
    {
      [[ -z "$cwd" ]] || cd "$cwd" 2>/dev/null
      timeout "$TIER_HOOK_TIMEOUT_S" node "$hook" --only inject-review-tier 2>/dev/null
    })"
  rc=$?
  # shellcheck source=scripts/lib/guard-log.sh
  if ((rc == 124)) && source "$(dirname "${BASH_SOURCE[0]}")/lib/guard-log.sh" 2>/dev/null; then
    gl_log "inject-review-tier outran ${TIER_HOOK_TIMEOUT_S} s — a typed /code-review went without its review tier"
  fi
  printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext // empty' 2>/dev/null
}
if [[ "$matched" == "code-review" ]]; then
  review_standards_log_missing_base 2>/dev/null
  reserve || exit 0
  tier="$(review_tier)"
  # Unloaded, the threshold reads 0 and the tier leads: the order that survives
  # persistence (#1746).
  # shellcheck source=scripts/lib/hook-limits.sh
  source "$(dirname "${BASH_SOURCE[0]}")/lib/hook-limits.sh" 2>/dev/null
  rules="You invoked /code-review, whose vendored skill file cannot carry project rules. ${standards} ${dispatch} ${deviations_read} ${ultra} ${disposition}${priced_options}"
  if [[ -z "$tier" ]]; then
    emit "$rules"
  elif ((${#rules} + 2 + ${#tier} < ${HOOK_PERSIST_CHARS:-0})); then
    emit "${rules}"$'\n\n'"${tier}"
  else
    emit "${tier}"$'\n\n'"${rules}"
  fi
  exit 0
fi

# /wayfinder's own clauses: the write-back rule for a disposed finding
# (mantahostels#3205) and the clause that keeps a research subagent out of docs/
# (mantahostels#918).
#
# The research clause goes to /wayfinder ALONE: it is the research command.
# /implement is not left blind: it carries `rule:research-artefact-scratch`
# in its own residue index instead (mantahostels#2499).
#
# THE CHARTING TERMINAL CONDITION (mantahostels#2585, ruled at mantahostels#2577 §1-2) is /wayfinder's
# alone and is PASTED rather than indexed: a session that misses it does the
# WRONG thing — it charts on past the point of done and schedules work
# /pick-next owns (mantahostels#2564). It cannot live in
# `.claude/skills/wayfinder/SKILL.md`, whose doc-map §A route is Vendored, so
# the next pull would drop it.
#
# check-context-budget.js counts a hand-maintained list of payload names, and a
# name outside it is refused as uncounted: rename this there too.
wayfinder_clauses=""
if [[ "$matched" == "wayfinder" ]]; then
  wayfinder_clauses=$'\n\n'"A RESOLUTION THAT DISPOSES OF A FINDING WRITES BACK TO THE SOURCE THAT DECLARED IT OPEN — a gap ledger, a \`Disposition: worth a ticket\` row, a \"no card covers this\" line, a \"parked — revisit as a card\" note. An editable source has its declaring line edited in place or deleted; a generated one at its generator's input; an aged \`docs/doc-map-classes.json\` \`role\` declaration is cleared there; a file that merely mentions the area takes nothing. Ruled at mantahostels#3205."$'\n\n'"### Research artefacts — the dispatch half, which binds however the research was dispatched. The subagent NEVER writes into \`docs/research/\`. Paste this into its prompt verbatim:"$'\n\n'"> Artefact: .claude/tmp/research-<name>.md"$'\n'">"$'\n'"> Write your findings to \`.claude/tmp/research-<name>.md\`, appending each the moment it lands rather than holding them back for your final report. Do NOT write anywhere under \`docs/\`, and do NOT commit anything. Report the absolute path of the file back to me when you finish. Write the artefact in ASD-STE100 Simplified Technical English."$'\n\n'"From a throwaway worktree hand the absolute path instead. Posting is the dispatching session's, never the subagent's, and its order is in \`docs/agents/issue-tracker.md\` §Research artefacts."$'\n\n'"**Size a reading agent's job to its context window:** split a large source family across agents, and have each save fetched text to disk and search it rather than read it whole (#1789)."$'\n\n'"### A charting run is DONE when four things are true, and not one ticket later. The map body is written; every ticket you can specify now exists as a child issue; their blocking edges are wired AND read back (\`rule:wayfinder-ops-shapes\` carries the shape; wiring one is not evidence it took); and every \`wayfinder:research\` ticket this run created is resolved and closed. Then nothing further is owed — end the session on \`result:\`. The one-ticket-per-session rule grants charting an exception for research tickets; SPENDING that exception is not a licence to carry on past it (mantahostels#2564, mantahostels#2577)."$'\n\n'"**What runs next across sessions belongs to \`/pick-next\` and the frontier query — never to you, and never to the founder as a question.** Which ticket THIS session resolves is still yours to choose; what is not yours is what runs after it or beside it. Naming the next ticket in order is reporting and is welcome. Asking him which ticket to run, in what order, or in which parallel batch, puts him a scheduling choice."
fi

# THE RESIDUE INDEX (mantahostels#2499, spec mantahostels#2457 §T4). A tracker rule WITH an
# observable `gh` Bash shape belongs in lib/tracker-rules.js, printed at the
# call that engages it (mantahostels#2497). What is left — a rule with no such
# shape — is named here instead, not left to a pointer at the whole document,
# which mantahostels#1870 measured mostly unfollowed: an id and the moment it
# binds, one line each, fetched only when that moment arrives with
# `scripts/lib/rule-text.sh <id> [<id>…]` (mantahostels#2494's list form). NEVER the rule's
# content: that is what the fragment in docs/agents/rules/ is for.
#
# EACH LINE'S `` `rule:<id>` `` SPAN MUST BE LITERAL, never built from a
# variable. scripts/check-guard-registry.js's readIndexedRuleIds() scans this
# file's own TEXT for that exact backtick-wrapped pattern to know an id is
# reachable (mantahostels#2496's second fragment class) — a `${id}` interpolation would be
# invisible to it and the id would report UNINDEXED-RULE.
#
# THE FETCH COMMAND ITSELF IS NAMED HERE, not only in this comment: a comment
# reaches nobody's context; only text this variable carries into
# `tracker_frame` does.
never_act_line="**Never act on a trigger from memory or inference** — fetch the id below at the moment named, not before, with \`scripts/lib/rule-text.sh <id> [<id>…]\` (one call resolves several)."

# EACH LINE IS ONE $'...' (ANSI-C QUOTED) LITERAL, never a plain `'...'`
# segment: check-context-budget.js's shellString() only evaluates `"..."` and
# `$'...'` right-hand sides (scripts/check-context-budget.js:597), so a bare
# single-quoted segment reads as an unparsed assignment and its bytes count as
# zero. A backtick is literal inside `$'...'`, exactly as inside `'...'`, so no
# backslash escape is needed either way — which is what keeps the
# `` `rule:<id>` `` span intact for check-guard-registry.js's regex too: an
# escaped `\`` would put a backslash between the id and the closing backtick in
# this file's own source text, which that regex does not match.
r_roadmap_gating=$'- `rule:roadmap-gating` — gating or closing an issue tied to a roadmap card\'s timing'
r_card_close_route=$'- `rule:card-close-route` — closing an issue that carries a roadmap card'
r_issue_title_card_id=$'- `rule:issue-title-card-id` — naming a new issue that carries a roadmap card'
r_decisions_search_first=$'- `rule:decisions-search-first` — calling a figure, term or card unsourced, undefined or undesigned'
r_research_artefact_scratch=$'- `rule:research-artefact-scratch` — dispatching a research subagent or posting its artefact outside /wayfinder'
r_wayfinder_ops_shapes=$'- `rule:wayfinder-ops-shapes` — a map, child ticket, blocking edge, frontier query, claim or resolve step, or a map left with nothing to resolve'
r_kind_label_vocabulary=$'- `rule:kind-label-vocabulary` — applying or reading a `kind:` label'
r_spec_only_contract=$'- `rule:spec-only-contract` — writing, amending or reading a spec, or lifting one filed under a `kind:brief` up to its map with `node scripts/promote-spec.js <brief>`'
r_takes_label_nuances=$'- `rule:takes-label-nuances` — applying, removing or reading `takes:children` or `takes:human`'
r_waiting_external_vocabulary=$'- `rule:waiting-external-vocabulary` — reading `waiting:external` (a label edit has the tracker-rules guard print it)'

# TWO ACTS STAY GUARD-ENFORCED AND SO STAY OUT OF THE INDEX ENTIRELY: a raw
# \`gh issue edit --body\` (denied by guard-issue-body.js) and a close naming no
# outstanding work (denied by guard-issue-close.js) — a session that never
# reads anything still learns both at the moment it trips one.
#
# THE EMPTY-RESULT LINE IS PASTED, NOT INDEXED (#523): an empty result can
# arrive on the very first \`gh\` call, before a fetched fragment could reach
# the session.
gh_empty_result_rule="ONE RULE IS PASTED, BECAUSE IT BINDS AT THE FIRST \`gh\` CALL: run \`gh\` in the foreground, and re-run an empty result once before believing it — the tracker-rules guard names the known causes on each call that meets one."

tracker_frame="THE TRACKER RULES ARE NOT BELOW — \`docs/agents/issue-tracker.md\` and \`docs/agents/triage-labels.md\` are their home, which the vendored skills carry none of. ${gh_empty_result_rule} Below is this command's index: every remaining rule with no \`gh\` shape a guard can catch it on, so it is named here instead of routed there. ${never_act_line}"

# ONE VARIABLE, ASSIGNED BY A CHAIN OF `if`s IN COMMAND ORDER — never a `case`,
# and never `elif`: check-context-budget.js parses this file's assignments
# textually and reads the LAST assignment to a name as ITS value, with no model
# of which `if` guards it. ORDER MATTERS: the arm producing the MOST bytes must be physically
# LAST, so the cap it feeds never under-counts.
#
# DO NOT HAND-GUESS WHICH ARM IS LARGEST. Re-measure after any edit to this
# block or to `tracker_frame`:
#   for c in card-close to-spec to-tickets to-tickets implement triage wayfinder; do
#     bash -c "matched=$c; source <(sed -n '/^never_act_line=/,/^fi\$/p' scripts/inject-tracker-docs.sh); printf '%s %s\n' \"\$c\" \"\${#tracker_index}\"";
#   done
# and put whichever prints the highest number physically last.
tracker_index=""
if [[ "$matched" == "card-close" ]]; then
  tracker_index=$'\n\n'"${tracker_frame}"$'\n'"${r_issue_title_card_id}"
fi
if [[ "$matched" == "to-spec" ]]; then
  tracker_index=$'\n\n'"${tracker_frame}"$'\n'"${r_kind_label_vocabulary}"$'\n'"${r_issue_title_card_id}"$'\n'"${r_spec_only_contract}"
fi
if [[ "$matched" == "to-tickets" ]]; then
  tracker_index=$'\n\n'"${tracker_frame}"$'\n'"${r_kind_label_vocabulary}"$'\n'"${r_issue_title_card_id}"$'\n'"${r_decisions_search_first}"$'\n'"${r_spec_only_contract}"
fi
if [[ "$matched" == "implement" ]]; then
  tracker_index=$'\n\n'"${tracker_frame}"$'\n'"${r_roadmap_gating}"$'\n'"${r_card_close_route}"$'\n'"${r_decisions_search_first}"$'\n'"${r_research_artefact_scratch}"
fi
if [[ "$matched" == "triage" ]]; then
  tracker_index=$'\n\n'"${tracker_frame}"$'\n'"${r_roadmap_gating}"$'\n'"${r_kind_label_vocabulary}"$'\n'"${r_takes_label_nuances}"$'\n'"${r_waiting_external_vocabulary}"
fi
if [[ "$matched" == "wayfinder" ]]; then
  tracker_index=$'\n\n'"${tracker_frame}"$'\n'"${r_roadmap_gating}"$'\n'"${r_decisions_search_first}"$'\n'"${r_wayfinder_ops_shapes}"$'\n'"${r_waiting_external_vocabulary}"
fi

# /implement's opening step (#893), and /triage's whole-spec review (#892),
# ride along here because the vendored skill file cannot carry them
# (as with the tracker rules above). /triage's arm, the longer, stays LAST:
# check-context-budget.js reads a name's last assignment as its value.
closing_steps=""
if [[ "$matched" == "implement" ]]; then
  closing_steps=$'\n\n'"Before starting, read the ticket's parent spec — the sub-issue parent claim-issue.js prints, or the issue a \`## Parent\` line names — and the resolution comment on each closed blocker (\`gh api repos/{owner}/{repo}/issues/<n>/dependencies/blocked_by\`)."
fi
if [[ "$matched" == "triage" ]]; then
  closing_steps=$'\n\n'"A \`kind:spec\` whose every ticket has closed gets a whole-spec review before you decide it: run \`node scripts/spec-commits.js <n>\`, then /code-review over the \`git show\` it prints, handing the reviewers the touched files at the spec's last commit, not only the diff lines. Each finding is FIXED, TICKETED or DECLINED, recorded in your triage comment, which ends with the \`**Reviewed through:** <40-hex sha>\` line the script prints. A TICKETED one is filed under the spec while it is open — retag the spec \`takes:triage\` → \`takes:children\` yourself; standalone, its body citing the spec, only where the spec had already closed (#897). A spec back at triage whose earlier comment carries a \`**Reviewed through:**\` line is reviewed over the commits since that sha only: \`node scripts/spec-commits.js <n> --since <sha>\`."
fi

# GROWING THIS SPENDS THE 10,000-CHARACTER BUDGET every command's payload
# fits inside. Cross it and that command's payload is persisted to a file
# instead, which sessions seldom open (mantahostels#1870) — so a rule added here
# past the line does not merely cost tokens, it stops arriving.
# check-injector-margin.sh refuses a commit that crosses it, and
# inject-tracker-docs.test.ts asserts every command under it.
# It names the `**Bound:**`, `**Values:**` and `**Practice:**` resolution lines because every
# command it reaches can resolve a ticket (#1801).
# bare-citation-ok: `#22 (gloss)` below is the citation form's own example.
header="You invoked /${matched}, which reads or writes the issue tracker. These project rules override the vendored skill's where they differ. Three the vendored skills get wrong: (1) claim the issue you are WORKING, and only that one: \`node scripts/claim-issue.js <n>\` before any other work on it — it refuses a live holder, then records the arbiter claim and assigns you (#530). NEVER one you file for later: it is created UNASSIGNED, as a claimed issue leaves /wayfinder's frontier (mantahostels#702). Claim it once you post a round on it (#1066). File with \`node scripts/file-issue.js\` — create, labels and parent link in one call — adding \`--assign-self\` only where the session works what it creates (\`/to-spec\`). Resolve with \`node scripts/resolve-ticket.js <n> --comment-file <f>\`: comment, close, claim release and map line in one call. Its comment carries a \`**Bound:**\` line — what you read in full, what you only sampled or cited — and a \`**Values:**\` line: each house or untraced value it relies on, or \`none\`; and a \`**Practice:**\` line: \`ran\`, \`covered\`, \`skipped\` or \`none-fits\` (mantahostels#1827, #1707, #2325); one naming a commit sha also a \`**Door:**\` line, two-way or one-way (issue-tracker.md §Every close that names a commit). Off those scripts the arbiter record is yours: a hook makes it only off a literal \`gh issue edit <n> --add-assignee @me\` or \`gh issue close <n>\` through the Bash tool; a raw create-time assignment, the web UI, any other script, \`gh api\`, \`--repo\` or a shell-variable issue number needs \`node scripts/session-arbiter.js claim-issue <n>\` or \`release-issue <n>\` by hand (§Claiming). (2) blocking edges and parent links use GitHub's native dependency and sub-issue endpoints, never a text \`Blocked by:\` line. (3) cite an issue number-first — \`#22 (gloss)\`, never \`[title](url)\` or a bare description; \`to-tickets\`'s \"numbers/titles\" is wrong on the order."

# The command-switching arm stays LAST: check-context-budget.js reads a name's
# last assignment as its value, and it is the longer.
takes_line=""
if [[ -n "$other_takes" ]]; then
  takes_line="#${takes_issue} is \`takes:${other_takes}\`, not \`takes:${matched}\`. Confirm with the founder first."$'\n\n'
fi
if [[ -n "$other_takes" && " ${COMMANDS[*]} " == *" ${other_takes} "* ]]; then
  takes_line="#${takes_issue} is \`takes:${other_takes}\`, not \`takes:${matched}\`. Confirm with the founder, or switch to /${other_takes}, first."$'\n\n'
fi

context="${takes_line}${header}${wayfinder_clauses}${tracker_index}${closing_steps}${priced_options}"

emit "$context"

exit 0
