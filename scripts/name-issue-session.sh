#!/usr/bin/env bash

set -uo pipefail

here="${BASH_SOURCE[0]%/*}"
[[ "$here" == "${BASH_SOURCE[0]}" ]] && here=.

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
source "$here/lib/atomic-write.sh" 2>/dev/null

# workflow-core#1785
# shellcheck source=scripts/lib/subagent-payload.sh
source "$here/lib/subagent-payload.sh" 2>/dev/null &&
  is_subagent_payload "$payload" && exit 0

session_id="$(jqr '.session_id // ""')"
prompt="$(jqr '.prompt // ""')"

if [[ -z "$prompt" && -n "${CLAUDE_JOB_DIR:-}" && -f "$CLAUDE_JOB_DIR/state.json" ]]; then
  prompt="$(jq -r '.intent // .detail // ""' "$CLAUDE_JOB_DIR/state.json" 2>/dev/null || true)"
fi

[[ -z "$prompt" ]] && exit 0

label=""
cmd=""
arg=""
for entry in "${COMMANDS[@]}"; do
  c="${entry%%:*}"
  # workflow-core#201
  re="(^|[[:space:]])/([A-Za-z0-9_-]+:)?${c}([[:space:]]|\$)"
  if [[ "$prompt" =~ $re ]]; then
    label="${entry#*:}"
    cmd="$c"
    arg="${prompt#*"${BASH_REMATCH[0]}"}"
    break
  fi
done

[[ -z "$label" ]] && exit 0

renamed=0
apply_name() {
  local name="$1"

  # workflow-core#3701
  if [[ -n "$session_id" && "${WFC_NAME_PREFIX_SESSION:-}" == "$session_id" ]]; then
    name="${WFC_NAME_PREFIX:-}$name"
  fi

  name="$(jq -rn --arg n "$name" \
    'if ($n | length) > 90 then ($n[0:89] + "…") else $n end' 2>/dev/null ||
    printf '%s' "$name")"

  local wrote=0

  if [[ -n "${CLAUDE_JOB_DIR:-}" && -f "$CLAUDE_JOB_DIR/state.json" ]]; then
    local state="$CLAUDE_JOB_DIR/state.json"
    aw_write "$state" jq -e --arg n "$name" \
      '.name = $n | .nameSource = "user" | .updatedAt = (now | todate)' \
      "$state" 2>/dev/null && wrote=1
  fi

  # shellcheck source=scripts/lib/guard-root.sh
  if [[ $wrote -eq 0 && -n "$session_id" ]] &&
    source "$here/lib/guard-root.sh" 2>/dev/null; then
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
  # lucmoseley/mantahostels#2380, lucmoseley/mantahostels#2338, lucmoseley/mantahostels#2337
  jq -nc --arg n "$1" '{systemMessage: ("Session named — " + $n)}'
}

if [[ "$cmd" == "pick-next" ]]; then
  goal="$(printf '%s' "$arg" | tr '\n' ' ' | sed -e 's/[[:space:]]\{1,\}/ /g' -e 's/^ //' -e 's/ $//')"
  name="Pick-next: $(date '+%Y-%m-%d %H:%M')"
  [[ -n "$goal" ]] && name="$name $goal"
  apply_name "$name"
  [[ $renamed -eq 0 ]] && exit 0
  announce "$name"
  exit 0
fi

numbers=()
repo=""
rest="$arg"
while true; do
  rest="${rest#"${rest%%[![:space:],&+]*}"}"
  [[ -z "$rest" ]] && break
  token="${rest%%[[:space:],&+]*}"
  [[ -z "$token" ]] && break
  rest="${rest#"$token"}"

  if [[ "${token,,}" == "and" ]]; then
    continue
  fi

  token="${token%[.,;:]}"

  # workflow-core#1164
  if [[ "$token" =~ ^https?://github\.com/([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)/issues/([0-9]+)([/?#].*)?$ ]]; then
    [[ -z "$repo" ]] && repo="${BASH_REMATCH[1]}"
    numbers+=("${BASH_REMATCH[2]}")
  elif [[ "$token" =~ ^#?([0-9]+)$ ]]; then
    numbers+=("${BASH_REMATCH[1]}")
  else
    break
  fi
done

((${#numbers[@]})) || exit 0

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

# lucmoseley/mantahostels#998
stem="${label} ${joined}"
apply_name "$stem"

gh="${WFC_GH:-gh}"
command -v "$gh" >/dev/null 2>&1 || {
  [[ $renamed -eq 1 ]] && announce "$stem"
  exit 0
}

cwd="$(jqr '.cwd // ""')"
if [[ -n "$cwd" && -d "$cwd" ]]; then
  cd "$cwd" 2>/dev/null || {
    [[ $renamed -eq 1 ]] && announce "$stem"
    exit 0
  }
fi

first="${uniq_numbers[0]}"
if [[ -n "$repo" ]]; then
  title="$(timeout 12 "$gh" issue view "$first" --repo "$repo" --json title -q .title 2>/dev/null || true)"
else
  title="$(timeout 12 "$gh" issue view "$first" --json title -q .title 2>/dev/null || true)"
fi

if [[ -z "$title" ]]; then
  [[ $renamed -eq 1 ]] && announce "$stem (title lookup failed)"
  exit 0
fi

name="${stem}: ${title}"
apply_name "$name"

[[ $renamed -eq 0 ]] && exit 0
announce "$name"
exit 0
