#!/usr/bin/env bash
# Ask where a just-created issue belongs — and what label it takes — at the
# moment it is created.
#
# WHY A HOOK AND NOT A DOC. inject-tracker-docs.sh hands the tracker rules to
# six slash commands and says in its own header that an ad-hoc "open an issue
# for X" typed in prose "gets nothing, and cannot: that path has no
# distinguishing shape". That is true at UserPromptSubmit. At PostToolUse the
# shape is exactly `gh issue create` — the path an ad-hoc issue is filed by, and
# the one a rule in docs/agents/issue-tracker.md never reaches. The census that
# established it: mantahostels#136.
#
# WHY AFTER, NOT BEFORE. The issue exists, so its number is known and placement
# is one API call away rather than something to remember later. The parent is
# usually the session's own issue, which is why the name is read below.
#
# ONCE PER PROMPT, FOR PLACEMENT ONLY. An 18-ticket /to-tickets batch is one
# placement decision, not eighteen interruptions. The label asks do NOT share
# that cardinality: a batch shares one parent, not one disposition, so they run
# for every issue every call (mantahostels#314, the second issue of a batch, which a
# per-prompt ask left unlabelled; the fix had no ticket of its own).
#
# WHY LABELS TOO (mantahostels#136). The producer for `wayfinder:*` is the charting step of
# /wayfinder, which labels the tickets it creates. A session *working* a ticket
# and spinning one off mid-flight has no producer at all. It rides here rather
# than becoming a second hook: same event.
#
# The session's own issue says which family the new one joins: a session working
# a `wayfinder:*` child of a map, or the map itself, spawns a ticket that lands
# in that map either way, so the ask is `wayfinder:<type>`; under a spec it is
# `kind:ticket`. Silent when it cannot tell.
#
# ADVISORY, NOT A GUARD. mantahostels#103 ruled: deny on a structured fact where the action
# has no legitimate use, warn where the hook is inferring. A standalone
# cross-cutting issue legitimately carries no `wayfinder:*`, so this is inference.
#
# Never blocks: every failure path exits 0 and injects nothing.
#
# IMPLICIT:  after a `gh issue create`, injects an ask to place the new issue under a parent and label it — once per prompt for placement, every issue for labels; it applies neither itself.
# JUSTIFIED: fail-safe — an ad-hoc issue reaches no rule in docs/agents/issue-tracker.md, and PostToolUse is the only point at which its shape is visible (mantahostels#136).
# DEFEAT:    real, two ways, both silent. No `jq` on PATH exits at :54 before
#            the payload is even parsed. And CREATE_RE (:64) anchors `gh issue
#            create` to start-of-segment or after a separator, so `timeout 5
#            gh issue create`, `sh -c "gh issue create …"` and `xargs gh issue
#            create` all fail the match at :65 and exit unasked. Neither is
#            the `if: Bash(gh *)` field's doing (docs/agents/guard-authoring.md's
#            surface 4): anchored at mantahostels#2127, it now also declines to exec this
#            script on the wrapped spellings — but CREATE_RE was already
#            refusing them, so the set this script acts on is unchanged.

set -uo pipefail

payload="$(cat 2>/dev/null || true)"
command -v jq >/dev/null 2>&1 || exit 0
jqr() { printf '%s' "$payload" | jq -r "$1" 2>/dev/null || true; }

[[ "$(jqr '.tool_name // ""')" == "Bash" ]] || exit 0

# Command position only — start of line, or after a separator. A substring match
# also fires on a command that merely *mentions* the string (a grep for it, a
# heredoc, a jq payload containing it), which is noise on a hook that runs on
# every Bash call.
cmd="$(jqr '.tool_input.command // ""')"
CREATE_RE='(^|[;&|({]|&&|\|\|)[[:space:]]*gh[[:space:]]+issue[[:space:]]+create'
[[ "${cmd//$'\n'/;}" =~ $CREATE_RE ]] || exit 0

# The injection, with the core's scripts and docs/agents files spelled at the
# plugin root in an install, where a bare `scripts/x` resolves nowhere (workflow-core#1010).
# shellcheck source=scripts/lib/script-path.sh
source "${BASH_SOURCE[0]%/*}/lib/script-path.sh" 2>/dev/null
post_context() {
  local c="$1"
  declare -F resolve_script_paths >/dev/null && c="$(printf '%s' "$c" | resolve_script_paths)"
  jq -nc --arg c "$c" '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $c}}'
}

# Field name has changed across versions; accept either, and fall back to the
# whole payload — all that is wanted from it is the created issue's URL.
out="$(jqr '(.tool_output // .tool_response // .) | tostring')"

# Defined up here because the no-number branch runs before the label asks and
# says the same things. `link_generic` is `link` with the child number left a
# placeholder, that branch having none to fill in.
orphan_why="an issue with no parent sits outside every map, so /wayfinder's frontier query never offers it."
takes_field="the field that says which command opens it"
link_generic="To link once you have the number: scripts/link-sub-issue.sh <parent> <child> — it resolves the database id, POSTs it as a number and verifies from the parent side. "
takes_values="takes:wayfinder (/wayfinder — an open question whose resolution is a decision), takes:to-spec (/to-spec — a chunk large enough to need a spec before tickets), takes:to-tickets (/to-tickets — a spec ready to break into tickets), takes:implement (/implement — a specified unit of work), takes:triage (/triage — disposition not yet decided), takes:human (done outside Claude Code entirely), takes:children (a container — open a child instead)"

# EVERY issue the call created, not just the first. Space-separated, creation
# order preserved, duplicates dropped.
#
# Deduplicated in bash rather than with awk or sort: awk is one more binary this
# hook would have to find on PATH, and sort would reorder, losing which issue was
# created first — the one the placement paragraph names.
#
# One trailing character is captured because it decides: `/issues/313#issuecom…`
# is a comment permalink, so `gh issue create && gh issue comment 313` would
# otherwise report mantahostels#313 as created here and nag for its label.
created_all=""
while read -r m; do
  case "$m" in *'#') continue ;; esac
  n="${m##*/}"
  n="${n%%[^0-9]*}"
  [[ -n "$n" ]] || continue
  case " ${created_all} " in *" ${n} "*) continue ;; esac
  created_all="${created_all:+${created_all} }${n}"
done < <(printf '%s' "$out" | grep -oE '/issues/[0-9]+.?')
created="${created_all%% *}"

# Sets `place`; never exits, or the label asks below go with the placement one.
# Read before the no-number branch as well as after, or that branch repeats the
# placement ask for every create in the prompt.
prompt_id="$(jqr '.prompt_id // .session_id // ""')"
marker="${TMPDIR:-/tmp}/place-new-issue.${prompt_id:-none}"
place=1
[[ -n "$prompt_id" && -e "$marker" ]] && place=0
: >"$marker" 2>/dev/null || true

# A BACKGROUNDED CREATE CARRIES NO NUMBER (mantahostels#437 and mantahostels#442, the two issues
# this hook let through unlabelled). The number is read from the tool output
# above, but a `run_in_background` Bash call's output is the harness's "Command
# running in background with ID: …" stub, so no issue URL reaches this event.
# Backgrounding every `gh` call was the standing advice until workflow-core#523; this branch
# still asks a session that backgrounds a create.
#
# Gated on the job stub, not merely on the absence of a number: a create that
# failed, or `gh issue create --help`, also yields no URL, and nagging there
# sends the reader after a number nothing minted.
BG_RE='Command running in background|Output is being written to'
if [[ -z "$created" && "$out" =~ $BG_RE ]]; then
  ask="You ran \`gh issue create\`, but this hook cannot see which issue it made: the call was backgrounded, so its output is the job stub rather than the issue URL. Read the number from the job's output file, then give it a takes: label — ${takes_field}. Pick one: ${takes_values}."
  [[ $place -eq 1 ]] && ask="${ask} Place it too: ${orphan_why} Make it a sub-issue of whichever issue spawned it, or say in its body that it is deliberately standalone. ${link_generic}"
  post_context "${ask} Rules: docs/agents/triage-labels.md and docs/agents/issue-tracker.md, \"Placing a new issue\"."
  exit 0
fi

# Everything below names `$created`, so it has nothing to say without one.
[[ -n "$created" ]] || exit 0

# The session's own issue is the leading candidate parent. name-issue-session.sh
# has already written the name as "<Verb> <n>: <title>" — background jobs onto
# the job record, interactive sessions onto the pid-keyed registry entry that
# claims this session id.
name=""
if [[ -n "${CLAUDE_JOB_DIR:-}" && -f "$CLAUDE_JOB_DIR/state.json" ]]; then
  name="$(jq -r '.name // ""' "$CLAUDE_JOB_DIR/state.json" 2>/dev/null || true)"
fi
if [[ -z "$name" ]]; then
  sid="$(jqr '.session_id // ""')"
  # The registry name-issue-session.sh wrote, under CLAUDE_CONFIG_DIR (workflow-core#2095).
  # shellcheck source=scripts/lib/guard-root.sh
  if [[ -n "$sid" ]] && source "$(dirname "${BASH_SOURCE[0]}")/lib/guard-root.sh" 2>/dev/null; then
    gr_config_dir cfg
    # shellcheck disable=SC2154 # gr_config_dir assigns cfg through printf -v
    for f in "$cfg"/sessions/*.json; do
      [[ -r "$f" ]] || continue
      n="$(jq -r --arg s "$sid" 'if .sessionId == $s then (.name // "") else "" end' "$f" 2>/dev/null || true)"
      [[ -n "$n" ]] && {
        name="$n"
        break
      }
    done
  fi
fi
session_issue="$(printf '%s' "$name" | grep -oE '^[A-Za-z]+ +[0-9]+:' | tr -dc '0-9')"

link="To link: scripts/link-sub-issue.sh <parent> ${created} — it resolves the database id, POSTs it as a number and verifies from the parent side. Rules: docs/agents/issue-tracker.md, \"Placing a new issue\"."

# --- which labels the new issues take -----------------------------------------
# A hook that cannot reach GitHub must not stall the session, or claim a label is
# missing when it never looked.
#
# BUDGET. The hook's timeout in self-plugin/hooks/hooks.json is 10s, and being killed on
# it loses the whole injection — the marker above is already written, so nothing
# retries. One session lookup at 3s plus MAX_ASK lookups at 2s must stay under
# that with room for the session-registry scan, which costs one jq per file.
#
# MAX_ASK caps the lookups, NOT the asks: issues past it are still named, from
# the payload alone, at no call each.
MAX_ASK=2
ghjson() { timeout "$1" gh issue view "$2" --json "$3" 2>/dev/null || true; }
labels_of() { printf '%s' "$1" | jq -r '[.labels[]?.name] | join(" ")' 2>/dev/null || true; }

label=""
takes=""
overflow=""
mine=""
gh_ok=0
command -v gh >/dev/null 2>&1 && gh_ok=1

# The session's own labels fix the family EVERY issue in this call joins, so they
# are read once here rather than once per issue.
[[ $gh_ok -eq 1 && -n "$session_issue" ]] &&
  mine="$(labels_of "$(ghjson 3 "$session_issue" 'labels')")"

asked=0
for iss in $created_all; do
  asked=$((asked + 1))
  if [[ $asked -gt $MAX_ASK ]]; then
    overflow="${overflow:+${overflow}, }#${iss}"
    continue
  fi

  # Read below the `gh_ok` block too, so they must survive gh being absent — set
  # -u is on — and be reset per issue, or one issue's labels answer for the next.
  new_json=""
  new_labels=""
  if [[ $gh_ok -eq 1 ]]; then
    new_json="$(ghjson 2 "$iss" 'title,labels')"
    new_title="$(printf '%s' "$new_json" | jq -r '.title // ""' 2>/dev/null || true)"
    new_labels="$(labels_of "$new_json")"

    # A card issue takes no kind: and no wayfinder: type (docs/agents/triage-labels.md).
    # Em dash only, the form `<card-id> — <title>` that /card-close parses: accepting
    # ` -- ` as well would read "fix -- see mantahostels#136" as a card and drop the prompt on a
    # real miss, and a title /card-close cannot parse is not a card issue anyway.
    card_title=0
    [[ "$new_title" =~ ^[a-z0-9][a-z0-9-]*\ —\  ]] && card_title=1

    # Which family, THEN whether the new issue already has a member of it. The
    # other way round, a `kind:ticket` created under a map reads as labelled and is
    # never asked for its wayfinder type — silent here, flagged by the weekly check.
    if [[ -n "$new_json" && $card_title -eq 0 && -n "$mine" ]]; then
      # A spec or brief under a map takes no type — check-issue-labels.js's map
      # exemption (workflow-core#578).
      if [[ "$mine" == *"wayfinder:"* && "$new_labels" != *"wayfinder:"* &&
        "$new_labels" != *"kind:spec"* && "$new_labels" != *"kind:brief"* ]]; then
        label="${label:+${label}
}#${iss} carries no label. Its parent-to-be sits under a wayfinder map (#${session_issue} is labelled: ${mine}), so it needs a wayfinder:<type> — research (AFK, resolved by a /research subagent), prototype (build a rough artefact to react to), grilling (a conversation, the default), or task (manual work that unblocks a decision). pick-next.js sorts an unlabelled grilling ticket as a repo-writer. Apply it: gh issue edit ${iss} --add-label wayfinder:<type>. Rules: docs/agents/triage-labels.md."
      # `kind:spec`, not any `kind:` — a child of a ticket is not itself required to
      # be one, and check-issue-labels.js scopes the same way. Asking wider than the
      # backstop would demand a label nothing checks for.
      elif [[ "$mine" == *"kind:spec"* && "$new_labels" != *"kind:ticket"* ]]; then
        label="${label:+${label}
}#${iss} carries no label. #${session_issue} is a spec, so a ticket under it takes kind:ticket. Apply it: gh issue edit ${iss} --add-label kind:ticket. Rules: docs/agents/triage-labels.md."
      fi
    fi
  fi

  # Unconditional: an issue born outside a map needs a takes: as much as one born
  # inside it, so this asks whatever the session's own labels are. Advisory only,
  # never a deny — mantahostels#136 rejected a gate here because the label is not always
  # knowable at creation. Silent only when the issue already carries one.
  takes_how="Pick one — ${takes_values}. Apply it: gh issue edit ${iss} --add-label takes:<value>. Rules: docs/agents/triage-labels.md."
  if [[ -z "$new_json" ]]; then
    takes="${takes:+${takes}
}If #${iss} carries no takes: label yet, add one — it is ${takes_field}. ${takes_how}"
  elif [[ "$new_labels" != *"takes:"* ]]; then
    takes="${takes:+${takes}
}#${iss} carries no takes: label, which is ${takes_field}. ${takes_how}"
  fi
done

[[ -n "$overflow" ]] && takes="${takes:+${takes}
}Also created by this call: ${overflow}. Check each carries a takes: label — this hook stopped looking after ${MAX_ASK} to stay inside its own timeout, so it does not know whether they do."

text=""
if [[ $place -eq 0 ]]; then
  :
elif [[ -n "$session_issue" ]]; then
  text="You created #${created} while working #${session_issue}. Place it before anything else: ${orphan_why} Choose one — (a) #${created} exists because of #${session_issue} (split out of it, surfaced while implementing it) → make it a sub-issue of #${session_issue}; (b) #${created} is peer work that #${session_issue}'s own parent owns, not caused by #${session_issue} → give it that same parent (gh api repos/{owner}/{repo}/issues/${session_issue} --jq .parent_issue_url); (c) #${created} carries a roadmap card (a \"<card-id> — …\" title) or is cross-cutting work with no single originator → leave it standalone and say so in its body. ${link}"
else
  text="You created #${created}. Place it before anything else: ${orphan_why} If it was spawned by another issue — split out of it, or surfaced while implementing it — make it that issue's sub-issue. If it carries a roadmap card (a \"<card-id> — …\" title) or is cross-cutting work with no single originator, leave it standalone and say so in its body. ${link}"
fi

# `${text:+…}` so a suppressed placement paragraph does not leave the injection
# opening on two blank lines.
[[ -n "$label" ]] && text="${text:+${text}

}${label}"

[[ -n "$takes" ]] && text="${text:+${text}

}${takes}"

# Nothing left to say: a later create in the same prompt whose issues already
# carry their labels.
[[ -n "$text" ]] || exit 0

post_context "$text"

exit 0
