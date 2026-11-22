#!/usr/bin/env bash

set -uo pipefail

THRESHOLD=50
PROSE=(
  . ':(exclude)*.js' ':(exclude)*.mjs' ':(exclude)*.cjs'
  ':(exclude)*.ts' ':(exclude)*.tsx' ':(exclude)*.jsx'
  ':(exclude)*.py' ':(exclude)*.sh' ':(exclude)*.json'
  ':(exclude)*.css' ':(exclude)*.svg' ':(exclude)*.lock'
  ':(exclude)*.png' ':(exclude)*.jpg' ':(exclude)*.webp' ':(exclude)*.ico'
  ':(exclude)public' ':(exclude).husky'
)

here="${BASH_SOURCE[0]%/*}"
[[ "$here" == "${BASH_SOURCE[0]}" ]] && here=.
# shellcheck source=scripts/lib/guard-root.sh
source "$here/lib/guard-root.sh"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null
declare -F gl_log >/dev/null 2>&1 || gl_log() { :; }
skip_nags() {
  gl_log "$1 — concision and code-review nags skipped"
  exit 0
}
# shellcheck source=scripts/lib/script-path.sh
source "$here/lib/script-path.sh" 2>/dev/null ||
  gl_log "lib/script-path.sh did not load — nag paths left bare"
# shellcheck source=scripts/lib/marker-root.sh
source "$here/lib/marker-root.sh"
# shellcheck source=scripts/lib/concision-marker.sh
source "$here/lib/concision-marker.sh"
# shellcheck source=scripts/lib/code-signal.sh
source "$here/lib/code-signal.sh" 2>/dev/null || skip_nags "lib/code-signal.sh did not load"
# shellcheck source=scripts/lib/rule-text.sh
source "$here/lib/rule-text.sh" 2>/dev/null || {
  gl_log "lib/rule-text.sh did not load — nags named their rule fragments' paths"
  rule_or_path() {
    local where
    gl_log "rule:$1 unreadable — nag printed its path instead"
    where="$(doc_path "agents/rules/$1.txt" 2>/dev/null)" || where="docs/agents/rules/$1.txt"
    printf '%s %s%s' "$2" "$where" "$3"
  }
}

hook_pwd="$PWD"
host="$(gr_root)"
cd "$host" 2>/dev/null || skip_nags "host root $host could not be entered"
markers_dir="$(gr_markers_dir)"
[[ -n "$markers_dir" ]] || skip_nags "no markers directory"
command -v jq >/dev/null 2>&1 || skip_nags "jq not on PATH"
command -v node >/dev/null 2>&1 || skip_nags "node not on PATH"

mode="${1:-stop}"
payload=$(cat)
sid=$(jq -r '.session_id // empty' <<<"$payload" 2>/dev/null)
[[ -n "$sid" ]] || skip_nags "payload named no session id"

# #4243
cwd=$(jq -r '.cwd // empty' <<<"$payload" 2>/dev/null)
tree="$(gr_session_tree "${cwd:-$hook_pwd}")" || skip_nags "git named no session tree for ${cwd:-$hook_pwd}"
cd "$tree" 2>/dev/null || skip_nags "session tree $tree could not be entered"

# shellcheck source=scripts/lib/review-suffix.sh
source "$here/lib/review-suffix.sh" 2>/dev/null ||
  gl_log "lib/review-suffix.sh did not load — review Artefact paths left unsuffixed"
review_sfx="$(review_suffix "$sid" 2>/dev/null)"
# shellcheck source=scripts/lib/review-agent-type.sh
source "$here/lib/review-agent-type.sh" 2>/dev/null ||
  gl_log "lib/review-agent-type.sh did not load — review subagent type defaulted to the plugin's"
review_type="$(review_agent_type 2>/dev/null)" || review_type="workflow-core:code-reviewer"
# shellcheck source=scripts/lib/review-standards.sh
source "$here/lib/review-standards.sh" 2>/dev/null ||
  gl_log "lib/review-standards.sh did not load — Standards axis handed both standards files unchecked"
# #2097
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

mine=$(mktemp 2>/dev/null) || exit 0
trap 'rm -f "$mine"' EXIT
if ! node "$here/session-arbiter.js" \
  writes "$sid" --committed >"$mine" 2>/dev/null; then
  # lucmoseley/mantahostels#135 lucmoseley/mantahostels#137
  exit 0
fi
[[ -s "$mine" ]] || exit 0

attributed() { attributed_to "$mine"; }
gitq() { git -c core.quotePath=false "$@"; }

reason=""

if [[ ! -f "$markers_dir/.concision-nagged-$sid" ]] && ! pass_valid "$markers_dir/.concision-pass-$sid" "$base"; then
  prose_fault="$pass_fault"
  mapfile -t prose_files < <(
    gitq diff --name-only "$base" -- "${PROSE[@]}" 2>/dev/null | attributed
  )
  mapfile -t untracked < <(
    gitq ls-files --others --exclude-standard -- "${PROSE[@]}" 2>/dev/null | attributed
  )

  add=0
  del=0
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
    reason+="This session added roughly $net net words of prose ($files) and has not run a concision pass. Run the concision-pass skill with fixed point $base, then report what was cut. Its closing step, mark-pass.js, writes .claude/tmp/markers/.concision-pass-$sid holding 'base=$base', 'findings=<number of cuts made>' and 'route=in-session'. If every addition is a founder-specified fact, say so, run that closing step with 0 cuts, and finish."
  fi
fi

# #1696 #1772
code_latch="$markers_dir/.codereview-nagged-$sid"
code_marker="$markers_dir/.codereview-pass-$sid"
latched_tier="" latched_sum=""
[[ -f "$code_latch" ]] && {
  IFS= read -r latched_tier
  IFS= read -r latched_sum
} <"$code_latch"
# #1803
marker_sum="$(cksum 2>/dev/null <"$code_marker")"
was_escalated="" new_marker=""
[[ "$latched_tier" = escalated ]] && was_escalated=1
[[ "$latched_sum" != "$marker_sum" ]] && new_marker=1
if { [[ -z "$was_escalated" ]] || [[ -n "$new_marker" ]]; } &&
  review_uncovered "$code_marker" "$base" "$mine" "$cs_threshold" "$sid" &&
  { [[ ! -f "$code_latch" ]] ||
    { [[ "$cs_tier" = escalated ]] && [[ -z "$was_escalated" ]]; } ||
    { [[ -n "$cs_pass_fault" ]] && [[ -n "$new_marker" ]]; }; }; then
  latch_tier="$cs_tier"
  [[ -n "$was_escalated" ]] && latch_tier=escalated
  printf '%s\n%s\n' "$latch_tier" "$marker_sum" >"$code_latch"
  [[ -n "$reason" ]] && reason+=" ALSO: "
  [[ -n "$cs_pass_fault" ]] &&
    reason+="The marker .claude/tmp/markers/.codereview-pass-$sid was rejected — $cs_pass_fault — so it counts as no review. "
  # #1697
  dispatch_shape="$(rule_or_path review-dispatch-shape "Dispatch the review runs as" " says.")"
  [[ -n "$cs_implement" ]] &&
    reason+="This session ran /implement, so the two-axis review is mandatory at any diff size — the ${CODE_THRESHOLD}-line churn floor does not apply here (mantahostels#2769). "
  review_standards_log_missing_base 2>/dev/null
  marker_script="$(script_path write-review-marker.js 2>/dev/null)" || marker_script=scripts/write-review-marker.js
  reason+="$cs_tier_line "
  reason+="This session changed code (${cs_files% }) without a review. Run the code-review skill with fixed point $base. Reviewer type \`${review_type}\`; Artefact paths \`.claude/tmp/review-standards${review_sfx}.md\` and \`.claude/tmp/review-spec${review_sfx}.md\`. ${dispatch_shape} ${standards_line} Then run the concision-pass skill over the comments and docstrings the change added (code-review's smell baseline does not cover comments), here in this session and not in a subagent (mantahostels#1143), dispatching its own fresh-reader agents on \`model: \"haiku\"\` — the reviewer pin above is code review's alone (mantahostels#2614). Then record it: node ${marker_script} --base $base --findings <total distinct findings across every run>.${cs_marker_more} If the change was pure deletion or a mechanical rename, say so, run it with --skipped deletion|rename --findings 0 in place of the review, and finish."
fi

[[ -n "$reason" ]] || exit 0
# #2031
if [[ -n "$cs_implement" ]]; then
  reason+=" $(rule_or_path implement-closing-steps "This session ran /implement: its closing steps are in" .)"
fi
jq -n --arg r "$reason" '{decision: "block", reason: $r}' 2>/dev/null || exit 0
exit 0
