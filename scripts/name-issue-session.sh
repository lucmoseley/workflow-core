#!/usr/bin/env bash
# Name the session after the issue it was opened on.
#
# Why: the Wayfinder → spec → tickets → implement chain runs one issue per
# session, several in parallel. In the session list they all read
# `<repo>-76` or `8f1d1fe4` — telling them apart means opening each one.
#
# Six entry points. The first five take GitHub issue references — a URL, `#17`,
# a bare `17`, or several of those separated by a comma, `and`, `&` or `+`:
#
#   /wayfinder  <tickets>  ->  Wayfinder 17, 19: <title of 17>
#   /to-spec    <map>      ->  Spec 17: <title>
#   /to-tickets <spec>     ->  Tickets 17: <title>
#   /implement  <tickets>  ->  Implement 17, 19: <title of 17>
#   /triage     <ticket>   ->  Triage 17: <title>
#   /pick-next  [goal]     ->  Pick-next: 2026-08-21 13:29 <goal>
#
# EVERY issue given is enumerated before the colon; the title is the FIRST
# one's. The verb in front is what the session is doing to them.
#
# Each is also recognised namespaced — `/workflow-core:pick-next` (#201).
#
# REFERENCES ARE READ FROM THE FRONT OF THE ARGUMENT ONLY, stopping at the
# first token that is not one — so `/wayfinder I read this in the last 30 days`
# names nothing rather than naming `Wayfinder 30`.
#
# WHICH OF ITS TWO EVENTS DOES THE WORK is a race the daemon usually loses, and
# the Claude Code version moves the odds:
#
#   UserPromptSubmit — the opening prompt, live or background. Always works.
#   SessionStart     — a *background* job's resume, and its fresh start only
#                      when the daemon has already written the job's `intent`.
#                      Interactive SessionStart has none to read and names
#                      nothing.
#
# So NEVER unwire UserPromptSubmit on the strength of a version: it is the only
# route that is not a race, and even the version that wins the race most still
# leaves some jobs unnamed without it (mantahostels#998, mantahostels#1142; per-version counts there,
# re-measured by scripts/measure-sessionstart-intent/). Both firing costs
# nothing, the rename being idempotent.
#
# HOW THE RENAME LANDS. Claude Code exposes no rename API to hooks, so this
# writes the session registry directly. Both registry writers merge onto
# whatever is on disk (read-modify-write), so a name set here survives the
# status updates that follow:
#
#   background   $CLAUDE_JOB_DIR/state.json     name + nameSource
#   interactive  $CLAUDE_CONFIG_DIR/sessions/<pid>.json  name (no nameSource)
#
# Read the interactive registry out of CLAUDE_CONFIG_DIR, never ~/.claude:
# this machine sets it to ~/.claude2 (mantahostels#998). gr_config_dir resolves
# it, as place-new-issue.sh's read of the name does.
#
# `nameSource: user` is deliberate: it is the one value Claude Code's own
# auto-namer refuses to overwrite. "auto" would let the conversation
# summariser clobber the issue name a few turns in.
#
# THE NAME IS WRITTEN BEFORE THE TITLE IS FETCHED, and again after, so a hook
# killed on its deadline costs the title and never the format (mantahostels#998). NEVER put
# anything that can block back on the path to the name — the 30s budget in
# settings.json is headroom, not the mechanism.
#
# LIMITS — this sets the name the session *list* shows (`claude agents`,
# FleetView, /resume). A live interactive TUI holds its title in memory and may
# not repaint until it re-reads the registry.
#
# Never blocks. Every failure path — no gh, no auth, private repo, malformed
# URL, or a command invoked with no issue at all — exits 0 and leaves the
# session as well named as it managed.
#
# IMPLICIT:  renames the session (a registry write) after the issue(s) it was opened on, or /pick-next's start time, at UserPromptSubmit and SessionStart, and announces the name in a systemMessage.
# JUSTIFIED: convenience — nothing degrades but legibility: parallel sessions all read as `<repo>-76` otherwise, and telling them apart means opening each.
# DEFEAT:    none — it renames whenever the prompt carries one of the six recognised shapes.

set -uo pipefail

# command : label. Order is irrelevant — none of the six prefixes the others.
COMMANDS=(
  "wayfinder:Wayfinder"
  "to-spec:Spec"
  "to-tickets:Tickets"
  "implement:Implement"
  "triage:Triage"
  "pick-next:Pick-next"
)

payload="$(cat 2>/dev/null || true)"

jqr() { printf '%s' "$payload" | jq -r "$1" 2>/dev/null || true; }

command -v jq >/dev/null 2>&1 || exit 0
# shellcheck source=scripts/lib/atomic-write.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/atomic-write.sh" 2>/dev/null

# A subagent's payload names its parent's session, whose command is not the
# subagent's (#1785).
# shellcheck source=scripts/lib/subagent-payload.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/subagent-payload.sh" 2>/dev/null &&
  is_subagent_payload "$payload" && exit 0

session_id="$(jqr '.session_id // ""')"
prompt="$(jqr '.prompt // ""')"

# SessionStart carries no prompt. A background job's opening prompt is recorded
# on the job as `intent`, which is where the command will be if this is one of
# these sessions. Interactive SessionStart has neither, and correctly no-ops.
if [[ -z "$prompt" && -n "${CLAUDE_JOB_DIR:-}" && -f "$CLAUDE_JOB_DIR/state.json" ]]; then
  prompt="$(jq -r '.intent // .detail // ""' "$CLAUDE_JOB_DIR/state.json" 2>/dev/null || true)"
fi

[[ -z "$prompt" ]] && exit 0

# Cheap gate first: none of the six commands, no work at all. This runs on
# every prompt, so it stays a string match until it has a reason not to.
label=""
cmd=""
arg=""
for entry in "${COMMANDS[@]}"; do
  c="${entry%%:*}"
  # THE PLUGIN NAMESPACE IS OPTIONAL (#201). inject-tracker-docs.sh carries a
  # copy of this regex and must stay in step with it.
  #
  # The prefix is matched as any word rather than the literal `workflow-core`,
  # which is the PLUGIN's name — set in plugin.json by whoever ships the
  # plugin, and not this repo's to fix on a fork's behalf.
  #
  # RESIDUAL: a plugin naming itself with a `.` or an `@` falls outside this
  # character class and is matched by nothing, silently.
  re="(^|[[:space:]])/([A-Za-z0-9_-]+:)?${c}([[:space:]]|\$)"
  if [[ "$prompt" =~ $re ]]; then
    label="${entry#*:}"
    cmd="$c"
    # Cut at the match the boundary regex found, not at the first substring:
    # `read docs/implement-notes then /implement 851` would otherwise leave
    # `-notes then …` as the argument and quietly name nothing.
    arg="${prompt#*"${BASH_REMATCH[0]}"}"
    break
  fi
done

[[ -z "$label" ]] && exit 0

# --- how the name gets written ----------------------------------------------
# Called twice: once with the number-only name, once with the title appended.
renamed=0
apply_name() {
  local name="$1"

  # Session names sit in a narrow list column; a 300-character issue title
  # would make the list less readable, not more. Ellipsis marks the cut.
  #
  # jq does the slicing because it counts codepoints whatever the locale is:
  # bash's ${name:0:89} counts BYTES under a C locale, and issue titles here
  # are full of em dashes, so it can cut one in half and hand jq --arg a
  # string that is not valid UTF-8.
  name="$(jq -rn --arg n "$name" \
    'if ($n | length) > 90 then ($n[0:89] + "…") else $n end' 2>/dev/null ||
    printf '%s' "$name")"

  local wrote=0

  # --- background job -------------------------------------------------------
  if [[ -n "${CLAUDE_JOB_DIR:-}" && -f "$CLAUDE_JOB_DIR/state.json" ]]; then
    local state="$CLAUDE_JOB_DIR/state.json"
    # -e: an empty state.json gives jq no output, which it then fails.
    aw_write "$state" jq -e --arg n "$name" \
      '.name = $n | .nameSource = "user" | .updatedAt = (now | todate)' \
      "$state" 2>/dev/null && wrote=1
  fi

  # --- interactive session --------------------------------------------------
  # The registry is keyed by pid, not session id, so find the file claiming
  # this session. An absent nameSource is how /rename marks a deliberate name.
  # shellcheck source=scripts/lib/guard-root.sh
  if [[ $wrote -eq 0 && -n "$session_id" ]] &&
    source "$(dirname "${BASH_SOURCE[0]}")/lib/guard-root.sh" 2>/dev/null; then
    local dir f
    gr_config_dir dir
    dir="$dir/sessions"
    for f in "$dir"/*.json; do
      [[ -f "$f" ]] || continue
      [[ "$(jq -r '.sessionId // ""' "$f" 2>/dev/null)" == "$session_id" ]] || continue
      aw_write "$f" jq -e --arg n "$name" \
        '.name = $n | del(.nameSource) | .updatedAt = (now * 1000 | floor)' \
        "$f" 2>/dev/null && wrote=1
      break
    done
  fi

  ((wrote)) && renamed=1
  return 0
}

announce() {
  # Model-dead, founder-visible. This systemMessage reached the model on none of
  # the 4,297 deliveries across both events this hook is wired to (mantahostels#2380, mantahostels#2338)
  # — an all-`bg` corpus, holding no foreground session to read one. A
  # foreground terminal does render it (mantahostels#2337), rendered not being the same as
  # noticed. So it stays: one jq call, and the rename's only surfacing.
  #
  # Do not reroute it to plain stdout — on UserPromptSubmit that IS the model's
  # context channel, and the agent has no use for its own session name.
  jq -nc --arg n "$1" '{systemMessage: ("Session named — " + $n)}'
}

# --- /pick-next: named by when it ran, not by an issue -----------------------
if [[ "$cmd" == "pick-next" ]]; then
  goal="$(printf '%s' "$arg" | tr '\n' ' ' | sed -e 's/[[:space:]]\{1,\}/ /g' -e 's/^ //' -e 's/ $//')"
  name="Pick-next: $(date '+%Y-%m-%d %H:%M')"
  [[ -n "$goal" ]] && name="$name $goal"
  apply_name "$name"
  [[ $renamed -eq 0 ]] && exit 0
  announce "$name"
  exit 0
fi

# --- issue numbers -----------------------------------------------------------
# Read issue references from the FRONT of the argument only, stopping at the
# first token that is not one. Scanning the whole argument would mine numbers
# out of prose — `/wayfinder I read this in the last 30 days` is a real way to
# open one of these, and it must name nothing rather than name `Wayfinder 30`.
numbers=()
repo=""
rest="$arg"
while true; do
  # Strip leading separators: whitespace, and the punctuation between
  # references — `851, 901`, `851 & 901`, `851 + 901`.
  rest="${rest#"${rest%%[![:space:],&+]*}"}"
  [[ -z "$rest" ]] && break
  token="${rest%%[[:space:],&+]*}"
  [[ -z "$token" ]] && break
  rest="${rest#"$token"}"

  # `and` joins references as often as a comma does, and swallowing it names
  # only the first ticket — a name that misstates which are in flight.
  if [[ "${token,,}" == "and" ]]; then
    continue
  fi

  # A reference is allowed the punctuation that follows it in a sentence:
  # `/wayfinder 962: the seeding question` should still name 962.
  token="${token%[.,;:]}"

  # The URL form keeps whatever GitHub's "copy permalink" appends — a
  # `#issuecomment-…` fragment or a query string. inject-tracker-docs.sh reads
  # the first reference with a copy of this parse (#1164): keep the two in step.
  if [[ "$token" =~ ^https?://github\.com/([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)/issues/([0-9]+)([/?#].*)?$ ]]; then
    [[ -z "$repo" ]] && repo="${BASH_REMATCH[1]}"
    numbers+=("${BASH_REMATCH[2]}")
  elif [[ "$token" =~ ^#?([0-9]+)$ ]]; then
    numbers+=("${BASH_REMATCH[1]}")
  else
    break
  fi
done

# No issue in the argument is a normal way to use these: /to-spec and
# /implement both work straight from conversation context. Nothing to name by.
((${#numbers[@]})) || exit 0

# De-duplicate, preserving the order given.
uniq_numbers=()
for n in "${numbers[@]}"; do
  seen=0
  for m in "${uniq_numbers[@]:-}"; do [[ "$m" == "$n" ]] && seen=1 && break; done
  ((seen)) || uniq_numbers+=("$n")
done

joined="$(
  IFS=,
  printf '%s' "${uniq_numbers[*]}"
)"
joined="${joined//,/, }"

# The number-only name goes on NOW, before any network call, so that a hook
# killed on its deadline still leaves the session correctly formatted.
stem="${label} ${joined}"
apply_name "$stem"

# --- the title ---------------------------------------------------------------
command -v gh >/dev/null 2>&1 || {
  [[ $renamed -eq 1 ]] && announce "$stem"
  exit 0
}

cwd="$(jqr '.cwd // ""')"
if [[ -n "$cwd" && -d "$cwd" ]]; then
  # A failed cd would leave this hook reading whatever repo the shell started in.
  cd "$cwd" 2>/dev/null || {
    [[ $renamed -eq 1 ]] && announce "$stem"
    exit 0
  }
fi

# Capped under the hook's budget: the title must never be why it is killed.
first="${uniq_numbers[0]}"
if [[ -n "$repo" ]]; then
  title="$(timeout 12 gh issue view "$first" --repo "$repo" --json title -q .title 2>/dev/null || true)"
else
  title="$(timeout 12 gh issue view "$first" --json title -q .title 2>/dev/null || true)"
fi

# No title means the lookup failed — unauthenticated, wrong repo, issue gone,
# too slow. The number-only name already landed, so say so and stop.
if [[ -z "$title" ]]; then
  [[ $renamed -eq 1 ]] && announce "$stem (title lookup failed)"
  exit 0
fi

name="${stem}: ${title}"
apply_name "$name"

[[ $renamed -eq 0 ]] && exit 0
announce "$name"
exit 0
