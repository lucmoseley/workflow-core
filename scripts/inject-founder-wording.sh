#!/usr/bin/env bash
# Hand a session the text a pattern names when the founder's prompt matches that
# pattern's wording, or when the agent loads the pattern's skill itself — spec
# workflow-core#628, widening spec workflow-core#496's recurrence hook (ruled at workflow-core#482).
#
# Patterns: recurrence — the four recurrence checks, fired by a fault the
# founder believed fixed coming back (workflow-core#514) or a `diagnosing-bugs` load (workflow-core#516);
# re-pitch — the `/wait-what` skill's body, fired by a founder asking for a
# simpler re-pitch of the last reply (workflow-core#642).
#
# Why: the prompt is the nearest event to the reply the text governs, so the
# text lands there rather than in an always-loaded file.
#
# INJECTION ONLY — it never denies, and every path exits 0. Recurrence's text
# is the rules fragment named after it, its `@CORPUS@` replaced here by
# the trackers `node scripts/lib/workflow-core-config.js corpus` resolves, since
# those vary by host. Where that route resolves none, cannot read the config, or
# warns that the host's own tracker is missing, the text says so and still fires.
# Re-pitch's text is the skill file's body, read at fire time beside this
# script, so the typed and the fired repair cannot drift (workflow-core#628).
#
# IMPLICIT:  injects the four recurrence checks and this host's tracker corpus into a session whose prompt names a fault coming back, or starts with `/diagnosing-bugs`, at UserPromptSubmit, and into one loading the `diagnosing-bugs` skill, at PreToolUse; and the `/wait-what` re-pitch into a session whose prompt asks for a simpler re-pitch, at UserPromptSubmit — without the session asking.
# JUSTIFIED: fail-safe — a recurrence diagnosed from scratch repeats the earlier fix's blind spot, and the founder pays for the fault a second time; a reply that missed is otherwise re-pitched from the agent's own defaults, since the founder never types `/wait-what` (workflow-core#628).
# DEFEAT:    the host's `disabled` list, on both routes and for every pattern. Otherwise none on the prompt route — keyed to the prompt's wording. The Skill route's latch: `scripts/clear-rule-latch.sh` clears it and the text is said again.
#
# LIMITS
#  - Recurrence: `again?`, `perpetual(ly)`, `still not` and `still broken` are
#    absent because their hits were mostly not recurrences (workflow-core#496).
#  - Re-pitch: bare `jargon`, bare `long-winded` and `simple steps` are absent —
#    their hits were notes on drafts for someone else, or step-by-step hand-over
#    asks (workflow-core#628). Its phrases were fitted to the sample they were measured on,
#    so ~98% precision is an upper bound and recall is unmeasured.
#  - Re-pitch is silent on a prompt starting with `/wait-what`, which already
#    delivers the text, and has no Skill route: `disable-model-invocation` keeps
#    the Skill tool from loading it.
#  - A prompt opening with a harness frame — a background-task notification, a
#    subagent's hand-back, a local command's output, Stop-hook feedback — never
#    fires, whatever it quotes (workflow-core#652). So a founder paste opening with one is
#    silent too, and any other pasted transcript quoting the phrases fires. The
#    hand-back's frame was captured on this route; the notification's is the
#    transcript's, never seen here.
#  - The prompt route is not latched: every matching prompt fires, since each may
#    name a different fault or follow a different reply that missed. The Skill
#    route is, once per session, agent and pattern, through gp_rule_told's
#    `warn.` latch, since its text never changes — unlatched, on the record,
#    where lib/guard-parse.sh does not load.
#  - A skill command the founder types expands without a Skill call, so only the
#    prompt route sees it.
#  - It never searches a tracker itself: the search terms need the agent's
#    reading of the fault, and a `gh` call here would sit on every prompt.
#  - It FAILS OPEN on anything it cannot read, and the fail-open is RECORDED
#    (mantahostels#147) — naming the pattern it dropped, where it got that far.
#  - Disabling is whole-hook: no host can silence one pattern alone.

set -uo pipefail

here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null
declare -F gl_log >/dev/null 2>&1 || gl_log() { :; }
declare -F gl_open >/dev/null 2>&1 || gl_open() { exit 0; }
# Sourced here rather than reached through gp_begin, which neither route calls,
# so a host listing this hook under "disabled" silences both (workflow-core#569).
# shellcheck source=scripts/lib/wfc-config.sh
source "$here/lib/wfc-config.sh" 2>/dev/null
declare -F wfc_disabled >/dev/null 2>&1 || wfc_disabled() { return 1; }
wfc_disabled "${0##*/}" 2>/dev/null && exit 0

# --- patterns ----------------------------------------------------------------
# Each is a name — its latch key — plus its label on the record, its phrase
# families, the skill whose load or typed command fires it (or none), the line a
# Skill load puts above its text, the command that silences it (or none), and
# the function printing its text. Order is the order texts join in one envelope.
PATTERNS=(recurrence-checks repitch)
declare -A LABEL PHRASES SKILL SKILL_PREFIX QUIET_ON TEXT_FN

LABEL["recurrence-checks"]="recurrence checks"
SKILL["recurrence-checks"]=diagnosing-bugs
SKILL_PREFIX["recurrence-checks"]="Applies only if this fault, or one like it, was fixed or ticketed before; otherwise ignore."
# `’` is the apostrophe a phone keyboard types.
RECURRENCE_FAMILIES=(
  "thought we(['’]d| had| have)? (already |just )?(fixed|solved|built|did|resolved|discussed|improved|wired|encoded)"
  "(second|third) time"
  "keeps? happening"
  "same (very dangerous )?mistake"
  "how many times"
  "i (swear i )?(previously|already) (asked|told|raised)"
  "going in circles"
  "still (seeing|approving|taking|failing|happening)"
)
PHRASES["recurrence-checks"]="$(IFS='|' && printf '%s' "${RECURRENCE_FAMILIES[*]}")"
TEXT_FN["recurrence-checks"]=recurrence_text

recurrence_text() {
  # shellcheck source=scripts/lib/rule-text.sh
  source "$here/lib/rule-text.sh" 2>/dev/null
  declare -F rule_text >/dev/null 2>&1 || {
    gl_log "lib/rule-text.sh did not load — recurrence checks not injected"
    return 1
  }
  local text
  text="$(rule_text recurrence-checks 2>/dev/null)" || {
    gl_log "recurrence-checks fragment unreadable — recurrence checks not injected"
    return 1
  }

  # The route prints one owner/name per line, and its OWN_MISSING_LINE
  # (lib/workflow-core-config.js) where the default lost the host's own tracker.
  local trackers=() own_missing=0 unreadable=0 route line
  if command -v node >/dev/null 2>&1; then
    route="$(node "$here/lib/workflow-core-config.js" corpus 2>&1)"
    if [[ $? -eq 2 ]]; then
      unreadable=1
      gl_log "corpus route could not read the config — recurrence checks name no tracker"
    fi
    while IFS= read -r line; do
      if [[ "$line" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
        trackers+=("\`$line\`")
      elif [[ "$line" == *"no own tracker resolves"* ]]; then
        own_missing=1
      fi
    done <<<"$route"
  else
    gl_log "node not found — recurrence checks name the corpus key, not its trackers"
  fi

  local corpus key
  corpus="$(IFS=, && printf '%s' "${trackers[*]}")"
  corpus="${corpus//,/, }"
  key="declare \`corpus\` in \`.claude/workflow-core.json\`"
  if ((unreadable)); then
    corpus="none: \`.claude/workflow-core.json\` does not read — fix it so \`corpus\` resolves"
  elif [[ -z "$corpus" ]]; then
    corpus="none resolves here — $key"
  elif ((own_missing)); then
    corpus="$corpus; this repo's own is missing — $key"
  fi

  # Parameter expansion, not ${//}: since bash 5.2 an `&` in a replacement
  # stands for the match.
  printf '%s' "${text%%@CORPUS@*}${corpus}${text#*@CORPUS@}"
}

LABEL[repitch]="re-pitch"
QUIET_ON[repitch]=wait-what
# `('|’)?`, not a bracket: under the C locale a bracket reads `’` as three bytes.
REPITCH_FAMILIES=(
  "simple and concise"
  "simpler"
  "simple (english|terms|language)"
  "concise (terms|language)"
  "no jargon"
  "plain (and simple )?english"
  "(response|answer|output|options?|questions?|wording|reply) (is|are) (still )?(very |incredibly |way |far )?(too[ -])?(confusing|unclear|long|long-?winded)"
  "not sure what you('|’)?re asking"
  "don('|’)?t understand (the question|what you('|’)?re asking)"
  "what are (we|you) (actually )?(deciding|asking)"
  "what (exactly )?(do you need|you want) (me|from me)"
  "explain (again|better|from here)"
  "you('|’)?re not making (any )?sense"
  "you('|’)?ve lost me"
  "expand the question"
  "still not explained"
)
PHRASES[repitch]="$(IFS='|' && printf '%s' "${REPITCH_FAMILIES[*]}")"
TEXT_FN[repitch]=repitch_text

repitch_text() {
  # Beside this script in the repo and in the plugin install alike (workflow-core#628 story 18).
  local skill="$here/../.claude/skills/${QUIET_ON[repitch]}/SKILL.md" body
  body="$(awk 'f; /^---$/ && ++n == 2 { f = 1 }' "$skill" 2>/dev/null)" && [[ -n "${body//[[:space:]]/}" ]] || {
    gl_log "wait-what skill file unreadable or empty — re-pitch not injected"
    return 1
  }
  body="${body#"${body%%[![:space:]]*}"}"
  printf '%s\n%s' "The founder's message asks for a simpler re-pitch of your last reply (\`/${QUIET_ON[repitch]}\`, fired by their wording). Apply this before anything else:" "$body"
}

slash_re() { printf '%s' '^[[:space:]]*/([a-z0-9-]+:)?'"$1"'([[:space:]]|$)'; }

payload="$(cat 2>/dev/null || true)"
[[ -n "$payload" ]] || gl_open "empty payload — founder-wording hook injected nothing"
command -v jq >/dev/null 2>&1 ||
  gl_open "jq not found — founder-wording hook injected nothing"
tool="$(printf '%s' "$payload" | jq -r '.tool_name // empty' 2>/dev/null)" ||
  gl_open "payload did not parse as JSON — founder-wording hook injected nothing"

matched=()
if [[ "$tool" == Skill ]]; then
  event=PreToolUse
  skill="$(printf '%s' "$payload" | jq -r '.tool_input.skill // empty' 2>/dev/null)" ||
    gl_open "payload's skill did not parse — founder-wording hook injected nothing"
  for p in "${PATTERNS[@]}"; do
    [[ -n "${SKILL[$p]-}" ]] || continue
    # A plugin skill arrives namespaced (workflow-core#201).
    case "$skill" in
      "${SKILL[$p]-}" | *:"${SKILL[$p]-}") matched+=("$p") ;;
    esac
  done
  ((${#matched[@]})) || exit 0

  # shellcheck source=scripts/lib/guard-parse.sh
  source "$here/lib/guard-parse.sh" 2>/dev/null
  if declare -F gp_adopt_payload >/dev/null 2>&1; then
    # Not gp_begin, which reads stdin the route test above has already read.
    gp_adopt_payload "$payload"
  else
    # Towards telling, as gp_rule_told's own faults fail (mantahostels#2275).
    gl_log "lib/guard-parse.sh did not load — Skill-route text injected unlatched"
    gp_rule_told() { return 1; }
    gp_rule_mark_told() { :; }
  fi
  unlatched=()
  for p in "${matched[@]}"; do
    gp_rule_told "$p" || unlatched+=("$p")
  done
  matched=("${unlatched[@]}")
else
  event=UserPromptSubmit
  prompt="$(printf '%s' "$payload" | jq -r '.prompt // empty' 2>/dev/null)" ||
    gl_open "payload did not parse as JSON — founder-wording hook injected nothing"
  [[ -n "$prompt" ]] || gl_open "no prompt in payload — founder-wording hook injected nothing"
  # lib/tool-calls-since.js's HARNESS_TEXT and lib/transcript.js's
  # STOP_FEEDBACK, plus a subagent's hand-back (workflow-core#652):
  # the hook gets it from `<agent-message`, the transcript from `Another Claude…`.
  harness_re='^[[:space:]]*(<task-notification>|<local-command-|<bash-stdout>|<bash-stderr>|Stop hook feedback|<agent-message[[:space:]]|Another Claude session sent a message:)'
  [[ "$prompt" =~ $harness_re ]] && exit 0

  shopt -s nocasematch
  for p in "${PATTERNS[@]}"; do
    # The leading class keeps a match from starting mid-word.
    phrase_re="(^|[^[:alnum:]_])(${PHRASES[$p]})"
    command_re="$(slash_re "${SKILL[$p]-}")"
    quiet_re="$(slash_re "${QUIET_ON[$p]-}")"
    [[ -n "${QUIET_ON[$p]-}" && "$prompt" =~ $quiet_re ]] && continue
    if [[ "$prompt" =~ $phrase_re ]] ||
      [[ -n "${SKILL[$p]-}" && "$prompt" =~ $command_re ]]; then
      matched+=("$p")
    fi
  done
  shopt -u nocasematch
fi

texts=()
told=()
for p in "${matched[@]}"; do
  t="$("${TEXT_FN[$p]}")" || continue
  if [[ "$event" == PreToolUse ]]; then
    t="${SKILL_PREFIX[$p]:+${SKILL_PREFIX[$p]}$'\n'}$t"
  fi
  texts+=("$t")
  told+=("$p")
done
((${#texts[@]})) || exit 0

text="${texts[0]}"
for t in "${texts[@]:1}"; do
  text+=$'\n\n'"$t"
done

# Emit, THEN latch (mantahostels#2261): a hook cancelled at its timeout has its
# stdout discarded, and a latch written first would never let it retry.
if jq -nc --arg e "$event" --arg c "$text" \
  '{hookSpecificOutput: {hookEventName: $e, additionalContext: $c}}' 2>/dev/null; then
  if [[ "$event" == PreToolUse ]]; then
    for p in "${told[@]}"; do
      gp_rule_mark_told "$p"
    done
  fi
else
  labels=()
  for p in "${told[@]}"; do labels+=("${LABEL[$p]}"); done
  dropped="$(IFS=, && printf '%s' "${labels[*]}")"
  gl_log "jq could not render the envelope — ${dropped//,/, } not injected"
fi
exit 0
