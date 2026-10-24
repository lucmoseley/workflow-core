#!/usr/bin/env bash
# PreToolUse: one rewrite of an Agent dispatch's input, carrying every change
# this repo makes to one — an `Artefact:` line where the prompt names no usable
# one, and, while burn mode is on, `sonnet` → `opus` (workflow-core#515) — and the dispatch
# rules (workflow-core#2013).
#
# Why one hook for both changes: two hooks each returning `updatedInput` on one
# call race, the last to finish winning (anthropics/claude-code#83353). The
# transforms and their composition are lib/dispatch-rewrite.js's, under test,
# which builds the envelope itself because none of lib/guard-parse.sh's
# helpers carries `updatedInput`; burn mode's table and marker are
# lib/burn-mode.js's, its switch scripts/burn-mode.sh's. The marker is one per
# MACHINE, so an `off` run anywhere ends the remap everywhere.
#
# What it does to a dispatch:
#   * a usable `Artefact:` line is left exactly as written;
#   * an unfilled one (`Artefact: TBD`, `<path>`, `none`) has its value
#     replaced in place; otherwise the line is appended. Either way two
#     instructions follow it: append findings as they land, and search a long
#     source on disk rather than read it whole (workflow-core#1789). The path is absolute:
#     <project root>/.claude/tmp/agents/<description slug>-<8 hex>.md;
#   * the session is told the path and the watcher command to watch it with,
#     the prompt's own artefact path where it names one; a dispatch with no
#     artefact to watch is told to end the turn;
#   * a named model the effort guide routes away from (lib/dispatch-rules.js)
#     gets rule:dispatch-tier, and a "search the repo" prompt naming no tracker
#     rule:dispatch-search-tracker, each fragment once a session;
#   * a dispatch from inside a subagent, `agent_id` on the payload, is DENIED
#     with rule:dispatch-grandchild;
#   * `statusline-setup`, which has no tool that can create a file, and
#     Explore and Plan, read-only by their own instructions (workflow-core#565), are exempt
#     by name (lib/dispatch-artefact.js's EXEMPT_AGENT_TYPES), and so is an
#     `isolation: "remote"` dispatch, which cannot write a local path. A fork
#     is not.
#
# IMPLICIT:  adds an `Artefact:` line to a dispatch prompt naming no usable one, and while burn mode is on moves a `sonnet` dispatch to `opus` — neither asked for by the session dispatching; denies a dispatch made from inside a subagent.
# JUSTIFIED: convenience — the session would have added the line itself after a refusal, at the cost of re-issuing the whole prompt (workflow-core#482); burn mode's remap is the founder's own switch (workflow-core#355).
# DEFEAT:    none for the line — name a real path in the prompt and it is left alone; `scripts/burn-mode.sh off` ends the remap; none for the subagent deny short of dispatching from the parent.
#
# LIMITS. The line is a PROMISE and nothing verifies it is kept: the agent may
# never write the file, or write it only at the end. The model field is
# rewritten and the prompt never is, so a prompt telling the agent which model
# it runs on now lies. It sees an `Agent` tool call and nothing else, so a
# subagent launched any other way is untouched. The two injected rules arrive
# with the dispatch's result, after the agent has launched: they correct the
# next dispatch, never the one that tripped them. The search detector is
# lexical, so a search phrased without its verbs, or a tracker named only as
# "the issues", passes unjudged. The harness applies
# `updatedInput` with an `allow`, which runs the call as rewritten; a denial
# from a sibling hook on this matcher still wins, and so does a settings
# `deny` or `ask` rule, which a hook `allow` never overrides. Whether an
# `allow` also skips the auto-mode classifier is undocumented (workflow-core#492). Every
# failure to compute leaves the dispatch as written, recorded as a fail-open;
# a burn-mode marker that cannot be placed (HOME unset or relative) leaves
# the model unmapped and still supplies the line.

set -uo pipefail

here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null

# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null
declare -F gp_begin >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-parse.sh did not load — dispatch left as written"
  exit 0
}

gp_begin '.tool_input' "agent dispatch"
input="$(gp_subject)"

# The matcher already limits this to the Agent tool. Re-checking stops a
# widened matcher rewriting some other tool's input (mantahostels#258).
tool="$(gp_payload_field '.tool_name')" ||
  gl_open "could not read tool_name from payload — dispatch left as written"
case "$tool" in
  Agent | Task | "") ;;
  *) exit 0 ;;
esac

# A subagent's own calls carry `agent_id`; the parent's never do.
agent="$(gp_payload_field '.agent_id')" ||
  gl_open "could not read agent_id from payload — dispatch left as written"
[[ -z "$agent" ]] ||
  gp_deny "$(gp_rule_text dispatch-grandchild 'A subagent does not spawn subagents: return, and let the parent dispatch (docs/agents/rules/dispatch-grandchild.txt).')"

lib="$here/lib/dispatch-rewrite.js"
[[ -r "$lib" ]] || gl_open "lib/dispatch-rewrite.js unreadable — dispatch left as written"

burn=off
if [[ ! -r "$here/lib/burn-mode.js" ]]; then
  gl_log "lib/burn-mode.js unreadable — burn mode left this dispatch unmapped"
elif marker="$(node "$here/lib/burn-mode.js" marker 2>/dev/null)"; then
  [[ -f "$marker" ]] && burn=on
else
  gl_log "burn-mode marker path unresolved — burn mode left this dispatch unmapped"
fi

# An empty root is lib/guard-parse.sh's disarm signal, never a path.
root="$(gr_root)"
[[ -n "$root" ]] || gl_open "project root unresolved — dispatch left as written"
out="$(printf '%s' "$input" | node "$lib" "$root" "$burn" 2>/dev/null)"
verdict=$?

# 0 = an envelope to hand back; 4 = the same, its artefact's directory unmade;
# 3 = nothing to say. Anything else is this hook unable to decide, which
# leaves the dispatch as written (mantahostels#103 §6).
case "$verdict" in
  0) ;;
  4) gl_log "artefact directory not made — the agent's first shell append will fail" ;;
  3) exit 0 ;;
  *) gl_open "dispatch-rewrite.js exited $verdict — dispatch left as written" ;;
esac

# The ids stay literal: lib/rule-emission.js reads them at these call sites.
list="$(jq -r '.rules | join(" ")' <<<"$out" 2>/dev/null)" ||
  gl_log "rules list unreadable — no dispatch rule spliced"
rules=" $list "
extra=""
tier=0 search=0
if [[ "$rules" == *" dispatch-tier "* ]]; then
  if ! gp_rule_told dispatch-tier; then
    extra+=$'\n\n'"$(gp_rule_text dispatch-tier 'docs/effort-guide.md is the sole authority on model and effort: read it before choosing either.')"
    tier=1
  fi
fi
if [[ "$rules" == *" dispatch-search-tracker "* ]]; then
  if ! gp_rule_told dispatch-search-tracker; then
    extra+=$'\n\n'"$(gp_rule_text dispatch-search-tracker 'A subagent told to "search the repo" searches files only: name the tracker in its prompt.')"
    search=1
  fi
fi

envelope="$(jq -c --arg extra "$extra" \
  '.envelope | .hookSpecificOutput.additionalContext += $extra' <<<"$out" 2>/dev/null)" ||
  gl_open "dispatch envelope did not render — dispatch left as written"
printf '%s\n' "$envelope"
if ((tier)); then
  gp_rule_mark_told dispatch-tier
fi
if ((search)); then
  gp_rule_mark_told dispatch-search-tracker
fi
exit 0
