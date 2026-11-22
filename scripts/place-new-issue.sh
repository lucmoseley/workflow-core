#!/usr/bin/env bash

set -uo pipefail

here="${BASH_SOURCE[0]%/*}"
[[ "$here" == "${BASH_SOURCE[0]}" ]] && here=.

payload="$(cat 2>/dev/null || true)"
command -v jq >/dev/null 2>&1 || exit 0
jqr() { printf '%s' "$payload" | jq -r "$1" 2>/dev/null || true; }

[[ "$(jqr '.tool_name // ""')" == "Bash" ]] || exit 0

cmd="$(jqr '.tool_input.command // ""')"
CREATE_RE='(^|[;&|({]|&&|\|\|)[[:space:]]*gh[[:space:]]+issue[[:space:]]+create'
[[ "${cmd//$'\n'/;}" =~ $CREATE_RE ]] || exit 0

# #1010
# shellcheck source=scripts/lib/script-path.sh
source "${BASH_SOURCE[0]%/*}/lib/script-path.sh" 2>/dev/null
post_context() {
  local c="$1"
  declare -F resolve_script_paths >/dev/null && c="$(printf '%s' "$c" | resolve_script_paths)"
  jq -nc --arg c "$c" '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $c}}'
}

out="$(jqr '(.tool_output // .tool_response // .) | tostring')"

orphan_why="an issue with no parent sits outside every map, so /wayfinder's frontier query never offers it."
takes_field="the field that says which command opens it"
link_generic="To link once you have the number: scripts/link-sub-issue.sh <parent> <child> — it resolves the database id, POSTs it as a number and verifies from the parent side. "
takes_values="takes:wayfinder (/wayfinder — an open question whose resolution is a decision), takes:to-spec (/to-spec — a chunk large enough to need a spec before tickets), takes:to-tickets (/to-tickets — a spec ready to break into tickets), takes:implement (/implement — a specified unit of work), takes:triage (/triage — disposition not yet decided), takes:human (done outside Claude Code entirely), takes:children (a container — open a child instead)"

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

prompt_id="$(jqr '.prompt_id // .session_id // ""')"
marker="${TMPDIR:-/tmp}/place-new-issue.${prompt_id:-none}"
place=1
[[ -n "$prompt_id" && -e "$marker" ]] && place=0
: >"$marker" 2>/dev/null || true

# lucmoseley/mantahostels#437, lucmoseley/mantahostels#442
BG_RE='Command running in background|Output is being written to'
if [[ -z "$created" && "$out" =~ $BG_RE ]]; then
  ask="You ran \`gh issue create\`, but this hook cannot see which issue it made: the call was backgrounded, so its output is the job stub rather than the issue URL. Read the number from the job's output file, then give it a takes: label — ${takes_field}. Pick one: ${takes_values}."
  [[ $place -eq 1 ]] && ask="${ask} Place it too: ${orphan_why} Make it a sub-issue of whichever issue spawned it, or say in its body that it is deliberately standalone. ${link_generic}"
  post_context "${ask} Rules: docs/agents/triage-labels.md and docs/agents/issue-tracker.md, \"Placing a new issue\"."
  exit 0
fi

[[ -n "$created" ]] || exit 0

name=""
if [[ -n "${CLAUDE_JOB_DIR:-}" && -f "$CLAUDE_JOB_DIR/state.json" ]]; then
  name="$(jq -r '.name // ""' "$CLAUDE_JOB_DIR/state.json" 2>/dev/null || true)"
fi
if [[ -z "$name" ]]; then
  sid="$(jqr '.session_id // ""')"
  # #2095
  # shellcheck source=scripts/lib/guard-root.sh
  if [[ -n "$sid" ]] && source "$here/lib/guard-root.sh" 2>/dev/null; then
    cfg=""
    gr_config_dir cfg
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

# #5528 guess: a 3s session lookup plus MAX_ASK 2s lookups under the hook's 10s timeout
MAX_ASK=2
gh="${WFC_GH:-gh}"
ghjson() { timeout "$1" "$gh" issue view "$2" --json "$3" 2>/dev/null || true; }
labels_of() { printf '%s' "$1" | jq -r '[.labels[]?.name] | join(" ")' 2>/dev/null || true; }

label=""
takes=""
overflow=""
mine=""
gh_ok=0
command -v "$gh" >/dev/null 2>&1 && gh_ok=1

[[ $gh_ok -eq 1 && -n "$session_issue" ]] &&
  mine="$(labels_of "$(ghjson 3 "$session_issue" 'labels')")"

asked=0
for iss in $created_all; do
  asked=$((asked + 1))
  if [[ $asked -gt $MAX_ASK ]]; then
    overflow="${overflow:+${overflow}, }#${iss}"
    continue
  fi

  new_json=""
  new_labels=""
  if [[ $gh_ok -eq 1 ]]; then
    new_json="$(ghjson 2 "$iss" 'title,labels')"
    new_title="$(printf '%s' "$new_json" | jq -r '.title // ""' 2>/dev/null || true)"
    new_labels="$(labels_of "$new_json")"

    card_title=0
    [[ "$new_title" =~ ^[a-z0-9][a-z0-9-]*\ —\  ]] && card_title=1

    if [[ -n "$new_json" && $card_title -eq 0 && -n "$mine" ]]; then
      # #578
      if [[ "$mine" == *"wayfinder:"* && "$new_labels" != *"wayfinder:"* &&
        "$new_labels" != *"kind:spec"* && "$new_labels" != *"kind:brief"* ]]; then
        label="${label:+${label}
}#${iss} carries no label. Its parent-to-be sits under a wayfinder map (#${session_issue} is labelled: ${mine}), so it needs a wayfinder:<type> — research (AFK, resolved by a /research subagent), prototype (build a rough artefact to react to), grilling (a conversation, the default), or task (manual work that unblocks a decision). pick-next.js sorts an unlabelled grilling ticket as a repo-writer. Apply it: gh issue edit ${iss} --add-label wayfinder:<type>. Rules: docs/agents/triage-labels.md."
      elif [[ "$mine" == *"kind:spec"* && "$new_labels" != *"kind:ticket"* ]]; then
        label="${label:+${label}
}#${iss} carries no label. #${session_issue} is a spec, so a ticket under it takes kind:ticket. Apply it: gh issue edit ${iss} --add-label kind:ticket. Rules: docs/agents/triage-labels.md."
      fi
    fi
  fi

  # lucmoseley/mantahostels#136
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

[[ -n "$label" ]] && text="${text:+${text}

}${label}"

[[ -n "$takes" ]] && text="${text:+${text}

}${takes}"

[[ -n "$text" ]] || exit 0

post_context "$text"

exit 0
