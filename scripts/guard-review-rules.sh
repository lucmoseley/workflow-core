#!/usr/bin/env bash
# PreToolUse guard: hand a session the code-review rules when it loads the
# code-review skill, rather than at the prompt that started the session (mantahostels#3451,
# applying mantahostels#3421's nearest-trigger ruling).
#
# It injects, and denies one call only: a bare `code-review` in a project with no
# `.claude/skills/code-review/` of its own (workflow-core#1165). The rules bind the review's
# dispatch and its disposition, both of which happen after the skill loads, so
# the one-call lag route (f) carries (docs/doc-map.md §Capture and placement §3,
# step 3) lands them before the first decision they bind rather than after it.
#
# IMPLICIT: on a Skill call naming `code-review` it injects the six review rules
#   and this session's two review-axis Artefact paths as additionalContext, and
#   writes a `.rule-injected-*` latch file per rule under .claude/tmp/markers. In an
#   adopter it denies the bare name instead, naming `workflow-core:code-review`.
# JUSTIFIED: fail-safe — the vendored skill cannot carry project rules, and a
#   rule handed to a session reaches it far more often than one it must fetch
#   (mantahostels#2501).
# DEFEAT: `scripts/clear-rule-latch.sh` clears the latch and the rules are said
#   again; deleting this registration from self-plugin/hooks/hooks.json silences them.
#   Any `.claude/skills/code-review/SKILL.md` in an adopter lifts the deny.
#
# THE ARTEFACT PATHS RIDE IN THE PRELUDE because a fragment is static and the
# paths are not: each carries the first 8 characters of the session id, so two
# concurrent reviews land on different files (mantahostels#2220). A subagent's Write expands
# no environment variable (mantahostels#2088), so the literal path has to be in the text.
#
# LIMITS
#  - It fires on the Skill TOOL only. A `/code-review` the founder types is
#    expanded without one, which is why scripts/inject-tracker-docs.sh keeps its
#    /code-review arm: for that session the prompt is the nearest event. A
#    review run by hand, with no skill loaded, is told nothing here;
#    scripts/concision-backstop.sh's Stop nag restates the dispatch shape.
#  - The plugin skill `code-review:code-review` reviews a pull request and is a
#    different skill, so it is not matched.
#  - The rules are stated ONCE PER SESSION, by gp_rule's latch, so a second
#    review in the same session is not told again.
#  - `review-dispatch-shape` points at the type and paths in the prelude, so it reads
#    right only in the prelude's envelope. The prelude and six fragments fit
#    GP_RULE_CAP whatever the checkout's path (workflow-core#1729); grow them past it and a
#    deferred fragment arrives on a later call without the paths. An adopter's
#    base path, in its plugin cache, still counts, along with its longer
#    subagent type and qualified citations: guard-review-rules.test.ts measures
#    the envelope at the longest one on the founder's machine (workflow-core#1882). The
#    sensitive-path tier rides in scripts/inject-review-tier.sh's own entry
#    for that reason.
#  - It FAILS OPEN on anything it cannot resolve, and the fail-open is RECORDED
#    (mantahostels#147). The one exception is gp_rule's store side, which exits 2 on a
#    fragment it cannot read (mantahostels#1762).

set -uo pipefail

# Same load gate as every other guard (mantahostels#157, mantahostels#147).
here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null

# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null
declare -F gp_begin >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-parse.sh did not load — code-review loaded without its rules"
  exit 0
}

gp_begin '.tool_input.skill' "skill call"

# A PLUGIN SKILL ARRIVES NAMESPACED (workflow-core#201). In an adopter this call is
# `workflow-core:code-review`, and matching the bare name alone let it through
# with no review rules at all. scripts/guard-last30days.sh matches the same way.
#
# `code-review:code-review` is Anthropic's own pull-request plugin, a different
# skill this guard stays out of the way of, so it is excluded BEFORE the
# namespaced arm rather than by narrowing that arm — a plugin may name itself
# anything, and only this one collision is known.
case "$(gp_subject)" in
  code-review:code-review) gp_allow ;;
  code-review | *:code-review) ;;
  *) gp_allow ;;
esac

# A BARE NAME IN AN ADOPTER IS THE HARNESS'S BUILT-IN REVIEWER (workflow-core#1165). Only a
# project carrying its own code-review skill — the core — shadows it. Injecting
# into the built-in hands the plugin's rules to a skill that never reads them,
# so it is refused instead. An unresolved root — gr_root's empty stub,
# guard-parse.sh's disarm signal — fails open to the injection below.
root="$(gr_root)"
local_skill="$root/.claude/skills/code-review"
if [[ "$(gp_subject)" == code-review && -n "$root" && ! -f "$local_skill/SKILL.md" ]]; then
  gp_deny "$(
    cat <<'EOF'
A bare `code-review` here is the harness's built-in reviewer, not workflow-core's: this project carries no code-review skill of its own (no `SKILL.md` under `.claude/skills/code-review/`). The built-in diffs only `@{upstream}...HEAD`, never your fixed point, and writes neither review-axis Artefact. Call the Skill tool with `workflow-core:code-review` instead, same fixed point (workflow-core#1165).
EOF
  )"
fi

PRELUDE_LATCH=review-rules-prelude

# An unreadable session id leaves the bare names, reinstating mantahostels#2220's collision
# in that one case rather than injecting nothing.
sid="$(gp_payload_field '.session_id')" || {
  gl_log "could not read session_id — review Artefact paths left unsuffixed"
  sid=""
}
# shellcheck source=scripts/lib/review-suffix.sh
source "$here/lib/review-suffix.sh" 2>/dev/null
if declare -F review_suffix >/dev/null 2>&1; then
  suffix="$(review_suffix "$sid")"
else
  gl_log "lib/review-suffix.sh did not load — review Artefact paths left unsuffixed"
  suffix=""
fi

# shellcheck source=scripts/lib/review-agent-type.sh
source "$here/lib/review-agent-type.sh" 2>/dev/null
if declare -F review_agent_type >/dev/null 2>&1; then
  review_type="$(review_agent_type)"
else
  gl_log "lib/review-agent-type.sh did not load — review subagent type defaulted to the plugin's"
  review_type="workflow-core:code-reviewer"
fi

# shellcheck source=scripts/lib/review-standards.sh
source "$here/lib/review-standards.sh" 2>/dev/null ||
  gl_log "lib/review-standards.sh did not load — Standards axis handed both standards files unchecked"
state=both
# The bare default for an unresolved core root, spelt here and not in
# lib/review-standards.sh: this file's text leaves through an emitter that
# resolves a doc path, as the lib's does not (script-path-scan.test.ts).
base="docs/code-standards-base.md"
glossary=""
if declare -F review_standards_state >/dev/null 2>&1; then
  state="$(review_standards_state)" || state=both
  base_shown="$(review_standards_base_shown)" && base="$base_shown"
  glossary="$(review_standards_glossary_line)" || glossary=""
fi

# The base path is machine-specific, so it rides in the prelude as the Artefact
# paths do; the four standards fragments name it as "the standards base named
# above" (workflow-core#965).
if ! gp_rule_told "$PRELUDE_LATCH"; then
  gp_rule_prelude "Rules for the code-review you are loading. This session's review subagent type: \`${review_type}\`. Its two review-axis Artefact paths: \`.claude/tmp/review-standards${suffix}.md\` and \`.claude/tmp/review-spec${suffix}.md\`. Its standards base: \`${base}\`.${glossary}"
  gp_rule_latch_after "$PRELUDE_LATCH"
  # Inside the latch, so a review is logged once rather than per Skill call.
  declare -F review_standards_log_missing_base >/dev/null 2>&1 &&
    review_standards_log_missing_base
fi

# Priority order: the deviations record is owed before the dispatch, and the
# dispatch shape before what each axis is handed. Whole calls on lines of their
# own, hence if/elif rather than `case`: check-guard-registry.js reads only a
# literal-id call that opens its line (EMIT_RULE_RE is anchored).
if [[ "$state" == base ]]; then
  gp_rule review-deviations-write review-dispatch-shape review-standards-axis-base review-deviations-read review-finding-destination review-ultra-axis
elif [[ "$state" == local ]]; then
  gp_rule review-deviations-write review-dispatch-shape review-standards-axis-local review-deviations-read review-finding-destination review-ultra-axis
elif [[ "$state" == neither ]]; then
  gp_rule review-deviations-write review-dispatch-shape review-standards-axis-absent review-deviations-read review-finding-destination review-ultra-axis
else
  gp_rule review-deviations-write review-dispatch-shape review-standards-axis review-deviations-read review-finding-destination review-ultra-axis
fi

gp_allow
