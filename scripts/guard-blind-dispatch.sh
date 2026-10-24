#!/usr/bin/env bash
# guard-blind-dispatch.sh — PreToolUse guard: a blind dispatch states that its
# git snapshot names no answer (#1783).
#
# Every subagent but Explore and Plan starts with a git snapshot taken at
# dispatch — branch, `git status` entries, the five latest commit subjects — and
# no dispatch can drop it. A subject naming an item under test, or its expected
# score, ends that item's blindness for the run. The rule and the recipe for a
# run with no snapshot are docs/agents/blind-dispatch.md's.
#
# What it does to an Agent dispatch whose prompt or description says "blind"
# ("blind spot" excepted):
#   * refuses it, printing the snapshot the subagent would read, unless the
#     prompt carries a `Blind-checked: <sha>` line naming the current HEAD;
#   * refuses one whose line names an older commit, printing the subjects
#     landed since;
#   * refuses a blind fork outright, a fork inheriting the dispatcher's whole
#     context;
#   * passes Explore and Plan, and every dispatch where
#     CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS is on — the recipe's child.
#
# Why a refusal rather than an injected rule: injected text reaches the session
# with the dispatch's result, after the subagent already holds its snapshot,
# and blind scorers go out in parallel fan-outs, all leaking before any of them
# returns (docs/doc-map.md §Capture and placement, step 3). The trigger is the
# word, an inference, so the escape is one line in the prompt rather than a
# wedge (mantahostels#103).
#
# LIMITS
#  - A blind dispatch that never says "blind" is not seen, and a prompt using
#    the word in another sense is refused once. Neither rate is measured.
#  - The line is the dispatcher's word that it read the snapshot; nothing checks
#    that it did, or judged it right.
#  - The line pins HEAD alone: a new untracked file, or another branch at the
#    same commit, still passes it.
#  - The `includeGitInstructions` setting hides the snapshot too, but a hook
#    cannot read a session's settings, so that child is still asked for the
#    line. The recipe uses the environment variable for this reason.
#  - An unborn branch, or a cwd outside any repository, passes: no commit
#    subject can leak, though status entries on an unborn branch still do.
#  - It FAILS OPEN on anything it cannot read, and records it (mantahostels#147).

set -uo pipefail

# How many subjects or status entries a refusal prints before counting the
# rest. A guess, never measured: enough to judge by, short of flooding.
MAX_LINES=20

here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null

# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null
declare -F gp_begin >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-parse.sh did not load — dispatch allowed unchecked"
  exit 0
}

gp_begin '.tool_input.prompt' "agent dispatch"
prompt="$(gp_subject)"

# Re-checked so a widened matcher cannot judge another tool's input
# (mantahostels#258).
tool="$(gp_payload_field '.tool_name')" ||
  gl_open "could not read tool_name from payload — dispatch allowed unchecked"
case "$tool" in
  Agent | Task | "") ;;
  *) exit 0 ;;
esac

# The recipe's child, and everything it dispatches, starts with no snapshot.
case "${CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS:-}" in
  1 | [Tt][Rr][Uu][Ee] | [Yy][Ee][Ss] | [Oo][Nn]) exit 0 ;;
esac

desc="$(gp_payload_field '.tool_input.description')" ||
  gl_open "could not read description from payload — dispatch allowed unchecked"
printf '%s\n%s\n' "$prompt" "$desc" |
  grep -qiP '\bblind(?:ed|ness)?\b(?![\s-]+spots?\b)' || exit 0

type="$(gp_payload_field '.tool_input.subagent_type')" ||
  gl_open "could not read subagent_type from payload — dispatch allowed unchecked"
case "$type" in
  Explore | Plan) exit 0 ;;
  fork)
    gp_deny "A fork inherits this session's whole context, so it is never blind: it knows everything you know about the answer. Dispatch the blind work as a fresh subagent (any type but fork), under the rule in docs/agents/blind-dispatch.md (#1783)."
    ;;
esac

cwd="$(gp_payload_field '.cwd')" || cwd=""
[[ -n "$cwd" ]] || cwd="$(gr_root)"
[[ -n "$cwd" ]] || gl_open "no cwd in payload and no project root — dispatch allowed unchecked"
git -C "$cwd" rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
head="$(git -C "$cwd" rev-parse --verify -q HEAD 2>/dev/null)" || exit 0
short="$(git -C "$cwd" rev-parse --short HEAD 2>/dev/null)" || short="$head"

unknown_note=""
checked="$(printf '%s\n' "$prompt" |
  sed -n 's/^[[:space:]]*Blind-checked:[[:space:]]*\([0-9a-fA-F]\{7,40\}\).*/\1/p' | tail -n 1)"

if [[ -n "$checked" ]]; then
  resolved="$(git -C "$cwd" rev-parse --verify -q "${checked}^{commit}" 2>/dev/null)" || resolved=""
  [[ "$resolved" == "$head" ]] && exit 0
  if [[ -n "$resolved" ]]; then
    since="$(git -C "$cwd" log --format='  %h %s' "${resolved}..HEAD" 2>/dev/null | head -n "$MAX_LINES")"
    [[ -n "$since" ]] || since="  (none on HEAD's own line — HEAD moved elsewhere)"
    gp_deny "This blind dispatch's \`Blind-checked: ${checked}\` is no longer HEAD. Commits landed since, which its snapshot would show:
${since}

If none names an item under test or its expected answer, change the line to \`Blind-checked: ${short}\` and re-send. If one does, run the blind work through the recipe in docs/agents/blind-dispatch.md (#1783)."
  fi
  unknown_note="Its \`Blind-checked: ${checked}\` names no commit in this repository. "
fi

branch="$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null)"
subjects="$(git -C "$cwd" log -5 --format='  %h %s' 2>/dev/null)"
status="$(git -C "$cwd" status --short 2>/dev/null)"
status_count="$(printf '%s' "$status" | grep -c '^' || true)"
status="$(printf '%s\n' "$status" | head -n "$MAX_LINES" | sed 's/^/  /')"
((status_count > MAX_LINES)) && status+=$'\n'"  … and $((status_count - MAX_LINES)) more"
((status_count == 0)) && status="  (clean)"

gp_deny "${unknown_note}This dispatch reads as blind, and the subagent will start with this git snapshot, taken now:

Branch: ${branch}
Recent commits:
${subjects}
Status:
${status}

If any of it names an item under test or its expected answer, do not send it: hold your own commit until the run reports, or run the blind work through the recipe in docs/agents/blind-dispatch.md, which starts it with no snapshot. If none does, add this line to the prompt and re-send:

Blind-checked: ${short}

Not a blind dispatch? Add the line anyway; the word \"blind\" is all this guard reads (#1783)."
