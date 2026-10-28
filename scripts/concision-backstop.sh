#!/usr/bin/env bash
# concision-backstop.sh — catches a session that wrote prose or code and ended
# without the matching quality pass.
#
#   concision-backstop.sh start   (SessionStart) — record the session's base SHA
#   concision-backstop.sh stop    (Stop)         — fire once per signal if unmet
#
# Two independent signals, each fired once per session — the code signal again
# when its tier turns escalated, and once per rejected marker written:
#   prose — net words added to non-code files exceeds THRESHOLD → demand the
#           concision-pass skill. THRESHOLD triggers auditing; it does not
#           judge bloat — the pass does, and it is cheap on small changes,
#           which is why the threshold sits low.
#   code  — code files changed by more than CODE_THRESHOLD lines → demand the
#           code-review skill, plus a concision pass over the comments and
#           docstrings the change added. That threshold is about price, not
#           bloat: a two-axis review costs ~2M tokens, so a trivial diff buys
#           less than it spends (mantahostels#1071) — except for an /implement session, where
#           any code change at all fires (IMPLEMENT_THRESHOLD). A written file
#           matching a declared sensitive glob fires at any size and type.
#
# Each nagged marker is written before the block, so there is no loop.
#
# ATTRIBUTION (mantahostels#114). Both signals read a diff of a REPO-GLOBAL
# working tree from inside a session-scoped hook, so without a filter they bill
# whichever session stops next for whatever every parallel session has been
# doing. So every candidate path is intersected with this session's own write
# ledger — the post-write core (scripts/lib/post-write.js) on PostToolUse, stored by
# scripts/session-arbiter.js — and the paths its own ledgered commits touched
# (#766, #2390) before anything is counted.
#
# A CHANGE ATTRIBUTABLE TO NOBODY IS BILLED TO NOBODY. A file written from Bash
# (a generator, a formatter, an inline interpreter) reaches no PostToolUse and
# so appears in the diff unclaimed until this session commits it. It is dropped
# rather than charged to the session that happens to be stopping. The two
# error directions are not symmetric: under-billing costs a missed quality
# pass, whereas over-billing tells a session to go and edit files
# a live parallel session is holding — the exact collision the file-claim guard
# exists to refuse. A script that writes a tracked doc already calls the
# arbiter's `claim`, which records for it.
#
# Every failure path exits 0 and stays silent — breaking a session is worse than
# missing one. A library that does not load is logged through lib/guard-log.sh,
# save guard-log.sh itself, which is the log.
#
# IMPLICIT:  records the session's base sha at SessionStart, and at Stop blocks the turn ending once per unmet signal — demanding the concision pass over prose added, or code-review over code changed or a declared sensitive path written; in an /implement session either nag ends with rule:implement-closing-steps, the only place a session meets those steps (#2031).
# JUSTIFIED: fail-safe — both are closing steps, and a session that has finished writing has no reason left of its own to run them.
# DEFEAT:    none — each signal fires once per session, the code signal again only on new news (above), and is cleared by doing the pass, not by a switch.

set -uo pipefail

THRESHOLD=50
# reference-roadmap.html stays in — it is the single biggest prose surface in
# the repo.
PROSE=(
  . ':(exclude)*.js' ':(exclude)*.mjs' ':(exclude)*.cjs'
  ':(exclude)*.ts' ':(exclude)*.tsx' ':(exclude)*.jsx'
  ':(exclude)*.py' ':(exclude)*.sh' ':(exclude)*.json'
  ':(exclude)*.css' ':(exclude)*.svg' ':(exclude)*.lock'
  ':(exclude)*.png' ':(exclude)*.jpg' ':(exclude)*.webp' ':(exclude)*.ico'
  ':(exclude)public' ':(exclude).husky'
)

# This script's directory without a `dirname` fork; `.` where run by a bare name.
here="${BASH_SOURCE[0]%/*}"
[[ "$here" == "${BASH_SOURCE[0]}" ]] && here=.
# shellcheck source=scripts/lib/guard-root.sh
source "$here/lib/guard-root.sh"
# Loaded first, so each library below whose load fails is logged, as is
# code-signal.sh's cs_fault; absent, each goes unlogged.
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null
declare -F gl_log >/dev/null 2>&1 || gl_log() { :; }
# doc_path, for the three defaults below; absent, they stay bare.
# shellcheck source=scripts/lib/script-path.sh
source "$here/lib/script-path.sh" 2>/dev/null ||
  gl_log "lib/script-path.sh did not load — nag paths left bare"
# shellcheck source=scripts/lib/marker-root.sh
source "$here/lib/marker-root.sh"
# The marker rules (#1005).
# shellcheck source=scripts/lib/concision-marker.sh
source "$here/lib/concision-marker.sh"
# The code signal push-review-owed.sh reads too (#1163): its paths, its floor
# and the /implement marker that lowers it.
# shellcheck source=scripts/lib/code-signal.sh
source "$here/lib/code-signal.sh" 2>/dev/null || {
  gl_log "lib/code-signal.sh did not load — concision and code-review nags skipped"
  exit 0
}
# The review dispatch shape and /implement's closing steps; absent, the nag
# names their paths instead.
# shellcheck source=scripts/lib/rule-text.sh
source "$here/lib/rule-text.sh" 2>/dev/null ||
  gl_log "lib/rule-text.sh did not load — nags named their rule fragments' paths"
cd "$(gr_root)" 2>/dev/null || exit 0
# Resolved once, after the cd above, so every marker path below is this
# absolute directory plus a bare filename.
markers_dir="$(gr_markers_dir)"
[[ -n "$markers_dir" ]] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0
# node reads the ledger, and a missing one would leave the ledger empty rather
# than absent — which reads exactly like a session that wrote nothing, so the
# backstop would fall silent for good with nothing to show for it.
command -v node >/dev/null 2>&1 || exit 0

mode="${1:-stop}"
sid=$(cat | jq -r '.session_id // empty' 2>/dev/null)
[[ -n "$sid" ]] || exit 0

# The two review-axis Artefact paths alone take the shortened suffix; every
# OTHER $sid use in this file (the marker filenames below) keeps the full id.
# A failed source leaves them bare (lib/review-suffix.sh's header).
# shellcheck source=scripts/lib/review-suffix.sh
source "$here/lib/review-suffix.sh" 2>/dev/null ||
  gl_log "lib/review-suffix.sh did not load — review Artefact paths left unsuffixed"
review_sfx="$(review_suffix "$sid" 2>/dev/null)"
# The core's bare `code-reviewer` or an adopter's plugin spelling (#741).
# shellcheck source=scripts/lib/review-agent-type.sh
source "$here/lib/review-agent-type.sh" 2>/dev/null ||
  gl_log "lib/review-agent-type.sh did not load — review subagent type defaulted to the plugin's"
review_type="$(review_agent_type 2>/dev/null)" || review_type="workflow-core:code-reviewer"
# shellcheck source=scripts/lib/review-standards.sh
source "$here/lib/review-standards.sh" 2>/dev/null ||
  gl_log "lib/review-standards.sh did not load — Standards axis handed both standards files unchecked"
# The default for where review-standards.sh, or the script-path.sh it reads
# the core root from, did not load, spelt at the plugin root in an install:
# the reason leaves through no resolver (#2096). The four texts below are
# inject-tracker-docs.sh's word for word, pinned by this script's test
# (#2097): two copies, as check-context-budget.js measures the injector's arm
# only from its literal text.
standards_base="$(doc_path code-standards-base.md 2>/dev/null)" || standards_base=docs/code-standards-base.md
base_shown="$(review_standards_base_shown 2>/dev/null)" && standards_base="$base_shown"
standards_state="$(review_standards_state 2>/dev/null)" || standards_state=both
if [[ "$standards_state" == base ]]; then
  standards_line="Hand the Standards axis the base \`${standards_base}\` in its prompt; its §0 routes the paths. No local \`docs/code-standards.md\` exists, so its report opens \`No local standards file: the base applies unchanged.\`, or \`Base unreadable: <path>\` if its Read of the base is refused. Cite a breach by its rule id; never restate a rule tooling enforces."
elif [[ "$standards_state" == local ]]; then
  standards_line="The standards base \`${standards_base}\` is absent: hand the Standards axis only the local \`docs/code-standards.md\` in its prompt, never raising a smell its \"Smells not raised\" (or \"Suppressions\") names. It reviews against that file and the smell baseline, and its report opens \`No standards base: ${standards_base} is absent.\` Cite a breach by its rule id; never restate a rule tooling enforces."
elif [[ "$standards_state" == neither ]]; then
  standards_line="This repo has neither the standards base \`${standards_base}\` nor a local \`docs/code-standards.md\`: hand the Standards axis neither. Tell it in its prompt to review against the smell baseline and any other standards source the skill's step 3 found, its report opening \`No standards base or local file: ${standards_base} and docs/code-standards.md are absent.\`"
else
  standards_line="Hand the Standards axis, in its prompt, base \`${standards_base}\` and local \`docs/code-standards.md\`. Base §0 routes the paths; a local change binds only via its changes table, cited \"§X2 (base), excepted by local row 2\", and no local \"Smells not raised\" (or \"Suppressions\") smell is raised. A refused base Read opens the report \`Base unreadable: <path>\`. Cite a breach by its rule id; never restate a rule tooling enforces."
fi
standards_line+="$(review_standards_glossary_line 2>/dev/null)"

code_signal_floor "$sid"

base_file="$(concision_base_file "$markers_dir" "$sid")"

if [[ "$mode" = "start" ]]; then
  [[ -f "$base_file" ]] || git rev-parse HEAD >"$base_file" 2>/dev/null
  exit 0
fi

base=$(concision_session_base "$markers_dir" "$sid") || exit 0

# --- attribution (mantahostels#114) ---
# The paths this session itself wrote or committed.
mine=$(mktemp 2>/dev/null) || exit 0
trap 'rm -f "$mine"' EXIT
if ! node "$here/session-arbiter.js" \
  writes "$sid" --committed >"$mine" 2>/dev/null; then
  # Non-zero means ATTRIBUTION UNAVAILABLE, never "wrote nothing" (mantahostels#135) — the
  # distinction the empty-file test below cannot see, which is why the status is
  # read rather than inferred (mantahostels#137). Both land on silence, for opposite
  # reasons: with no ledger to intersect, every candidate path is unattributable,
  # and the rule above bills those to nobody. The fault is not lost with the
  # nag — the arbiter logs it, and check-guard-errors surfaces it.
  exit 0
fi
# Removable without changing the output — an empty ledger already yields an empty
# match below. It skips the git diffs for read-only sessions, the common case.
[[ -s "$mine" ]] || exit 0

# quotePath=false on every git command feeding it: attributed_to's header.
attributed() { attributed_to "$mine"; }
gitq() { git -c core.quotePath=false "$@"; }

# --- pass markers: scripts/lib/concision-marker.sh ---
reason=""

# --- prose signal ---
if [[ ! -f "$markers_dir/.concision-nagged-$sid" ]] && ! pass_valid "$markers_dir/.concision-pass-$sid" "$base"; then
  # Captured now: the code signal below calls pass_valid again and overwrites it.
  prose_fault="$pass_fault"
  mapfile -t prose_files < <(
    gitq diff --name-only "$base" -- "${PROSE[@]}" 2>/dev/null | attributed
  )
  # A brand-new document is untracked, so no diff carries it — count it whole.
  mapfile -t untracked < <(
    gitq ls-files --others --exclude-standard -- "${PROSE[@]}" 2>/dev/null | attributed
  )

  add=0
  del=0
  # Guarded: `git diff $base --` with an empty pathspec list diffs the whole
  # tree, which would restore the misattribution this filter removes.
  if [[ "${#prose_files[@]}" -gt 0 ]]; then
    diff=$(git diff "$base" -- "${prose_files[@]}" 2>/dev/null)
    add=$(printf '%s\n' "$diff" | grep '^+' | grep -v '^+++' | wc -w)
    del=$(printf '%s\n' "$diff" | grep '^-' | grep -v '^---' | wc -w)
  fi

  new=0
  [[ "${#untracked[@]}" -gt 0 ]] &&
    new=$(printf '%s\n' "${untracked[@]}" | xargs -d'\n' cat 2>/dev/null | wc -w)

  net=$((add - del + new))
  if [[ "$net" -gt "$THRESHOLD" ]]; then
    files=$(
      printf '%s\n' "${prose_files[@]}" "${untracked[@]}" |
        grep -v '^$' | head -"$NAMED_PATHS_MAX" | tr '\n' ' '
    )
    touch "$markers_dir/.concision-nagged-$sid"
    [[ -n "$prose_fault" ]] &&
      reason+="The marker .claude/tmp/markers/.concision-pass-$sid was rejected — $prose_fault — so it counts as no pass. "
    # The pass runs HERE, in the session that wrote the prose (mantahostels#1143).
    # Accepted residual: it re-reads this session's own context.
    reason+="This session added roughly $net net words of prose ($files) and has not run a concision pass. Run the concision-pass skill with fixed point $base, then report what was cut. Its closing step, mark-pass.js, writes .claude/tmp/markers/.concision-pass-$sid holding 'base=$base', 'findings=<number of cuts made>' and 'route=in-session'. If every addition is a founder-specified fact, say so, run that closing step with 0 cuts, and finish."
  fi
fi

# --- code signal ---
# scripts/lib/code-signal.sh, over the working tree. The latch holds the tier
# it nagged at, so a change that turns escalated after a standard nag is nagged
# again (#1696), and the checksum of the marker it saw, so a marker written
# since and rejected is nagged again, naming why (#1772). A session that writes
# a marker has answered the nag; only the nag can tell it the answer failed.
code_latch="$markers_dir/.codereview-nagged-$sid"
code_marker="$markers_dir/.codereview-pass-$sid"
latched_tier="" latched_sum=""
[[ -f "$code_latch" ]] && {
  IFS= read -r latched_tier
  IFS= read -r latched_sum
} <"$code_latch"
# 2>/dev/null before the <: redirections apply left to right, so a missing
# marker, the normal case, would otherwise print the shell's own error (#1803).
marker_sum="$(cksum 2>/dev/null <"$code_marker")"
was_escalated="" new_marker=""
[[ "$latched_tier" = escalated ]] && was_escalated=1
[[ "$latched_sum" != "$marker_sum" ]] && new_marker=1
if { [[ -z "$was_escalated" ]] || [[ -n "$new_marker" ]]; } &&
  review_uncovered "$code_marker" "$base" "$mine" "$cs_threshold" "$sid" &&
  { [[ ! -f "$code_latch" ]] ||
    { [[ "$cs_tier" = escalated ]] && [[ -z "$was_escalated" ]]; } ||
    { [[ -n "$cs_pass_fault" ]] && [[ -n "$new_marker" ]]; }; }; then
  # An escalated latch stays escalated, so a tier that falls and rises again
  # is not nagged twice for the rise.
  latch_tier="$cs_tier"
  [[ -n "$was_escalated" ]] && latch_tier=escalated
  printf '%s\n%s\n' "$latch_tier" "$marker_sum" >"$code_latch"
  [[ -n "$reason" ]] && reason+=" ALSO: "
  [[ -n "$cs_pass_fault" ]] &&
    reason+="The marker .claude/tmp/markers/.codereview-pass-$sid was rejected — $cs_pass_fault — so it counts as no review. "
  # The standards path is restated from docs/agents/rules/review-*.txt,
  # which reach a review only through the code-review skill (mantahostels#958,
  # mantahostels#1011, mantahostels#3451). Keep the wordings in step. The dispatch
  # shape and its model pin are that fragment itself, printed (#1697). Its load,
  # fallback and "Reviewer type …" lead-in are repeated in inject-tracker-docs.sh's
  # /code-review arm, not shared: check-context-budget.js counts that arm by
  # parsing the injector, and reads the fragment only off a `rule_text`
  # assignment there (RULE_TEXT_RHS), so a helper's output would count as zero.
  # inject-tracker-docs.test.ts finds the concision pass's pin by the
  # `fresh-reader agents on` before it (mantahostels#2614).
  dispatch_shape="$(rule_text review-dispatch-shape 2>/dev/null)"
  if [[ -z "$dispatch_shape" ]]; then
    shape_path="$(doc_path agents/rules/review-dispatch-shape.txt 2>/dev/null)" || shape_path=docs/agents/rules/review-dispatch-shape.txt
    dispatch_shape="Dispatch the review runs as $shape_path says."
  fi
  [[ -n "$cs_implement" ]] &&
    reason+="This session ran /implement, so the two-axis review is mandatory at any diff size — the ${CODE_THRESHOLD}-line churn floor does not apply here (mantahostels#2769). "
  review_standards_log_missing_base 2>/dev/null
  marker_script="$(script_path write-review-marker.js 2>/dev/null)" || marker_script=scripts/write-review-marker.js
  reason+="$cs_tier_line "
  reason+="This session changed code (${cs_files% }) without a review. Run the code-review skill with fixed point $base. Reviewer type \`${review_type}\`; Artefact paths \`.claude/tmp/review-standards${review_sfx}.md\` and \`.claude/tmp/review-spec${review_sfx}.md\`. ${dispatch_shape} ${standards_line} Then run the concision-pass skill over the comments and docstrings the change added (code-review's smell baseline does not cover comments), here in this session and not in a subagent (mantahostels#1143), dispatching its own fresh-reader agents on \`model: \"sonnet\"\` — the reviewer pin above is code review's alone (mantahostels#2614). Then record it: node ${marker_script} --base $base --findings <total distinct findings across every run>.${cs_marker_more} If the change was pure deletion or a mechanical rename, say so, run it with --skipped deletion|rename --findings 0 in place of the review, and finish."
fi

[[ -n "$reason" ]] || exit 0
# Either nag in an /implement session prints its closing steps whole, though
# the code nag restates part: no preloaded text carries them (#2031), and
# no other gives the prose-file limb or the Door line.
if [[ -n "$cs_implement" ]]; then
  closing_steps="$(rule_text implement-closing-steps 2>/dev/null)"
  if [[ -z "$closing_steps" ]]; then
    cs_log "rule:implement-closing-steps unreadable — /implement nag printed its path instead"
    steps_path="$(doc_path agents/rules/implement-closing-steps.txt 2>/dev/null)" || steps_path=docs/agents/rules/implement-closing-steps.txt
    closing_steps="This session ran /implement: its closing steps are in $steps_path."
  fi
  reason+=" $closing_steps"
fi
jq -n --arg r "$reason" '{decision: "block", reason: $r}' 2>/dev/null || exit 0
exit 0
