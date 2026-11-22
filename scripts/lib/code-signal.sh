#!/usr/bin/env bash

# guess, lucmoseley/mantahostels#1071
CODE_THRESHOLD=20
# lucmoseley/mantahostels#2769
ANY_CHANGE=-1
IMPLEMENT_THRESHOLD=$ANY_CHANGE
CODE=(
  '*.js' '*.mjs' '*.cjs' '*.ts' '*.tsx' '*.jsx' '*.py' '*.sh'
  '.husky/'
)

_cs_dir="${BASH_SOURCE[0]%/*}"
[[ "$_cs_dir" == "${BASH_SOURCE[0]}" ]] && _cs_dir=.
_cs_dir="$(cd "$_cs_dir" 2>/dev/null && pwd)"
CS_MATCHER="$_cs_dir/sensitive-paths.js"
CS_ARBITER="${_cs_dir%/*}/session-arbiter.js"
unset _cs_dir
: "${cs_threshold-}" "${cs_implement-}" "${cs_tier_line-}" "${cs_marker_more-}"

code_signal_floor() {
  cs_threshold="$CODE_THRESHOLD"
  cs_implement=""
  if [[ -f "${TMPDIR:-/tmp}/wfc-tracker-inject-${UID:-0}/${1//[^A-Za-z0-9_-]/_}.implement" ]]; then
    cs_implement=1
    cs_threshold="$IMPLEMENT_THRESHOLD"
  fi
}

attributed_to() { grep -Fxf "$1" - 2>/dev/null || true; }

code_review_owed() {
  local base="$1" mine="$2" threshold="$3" to="${4:-}"
  local -a tracked_paths=() new_paths=()
  cs_files=""
  cs_churn=0
  mapfile -t tracked_paths < <(
    git -c core.quotePath=false diff --name-only "$base" ${to:+"$to"} -- "${CODE[@]}" 2>/dev/null |
      attributed_to "$mine"
  )
  [[ -n "$to" ]] || mapfile -t new_paths < <(
    git -c core.quotePath=false ls-files --others --exclude-standard -- "${CODE[@]}" 2>/dev/null |
      attributed_to "$mine"
  )

  if [[ "${#tracked_paths[@]}" -gt 0 ]]; then
    cs_churn=$(git diff --numstat "$base" ${to:+"$to"} -- "${tracked_paths[@]}" 2>/dev/null |
      awk '{a += $1; d += $2} END {print a + d + 0}')
  fi
  if [[ "${#new_paths[@]}" -gt 0 ]]; then
    cs_churn=$((cs_churn + $(printf '%s\n' "${new_paths[@]}" |
      xargs -d'\n' -r cat 2>/dev/null | wc -l)))
  fi

  local -a sensitive=()
  cs_tier=standard
  cs_area_names=()
  cs_areas=""
  cs_fault=""
  sensitive_match sensitive "$base" "$mine" "$to"
  [[ "${#sensitive[@]}" -gt 0 ]] && cs_tier=escalated

  cs_files=$(
    printf '%s\n' "${sensitive[@]}" "${tracked_paths[@]}" "${new_paths[@]}" |
      grep -v '^$' | awk '!seen[$0]++' | head -"$NAMED_PATHS_MAX" | tr '\n' ' '
  )
  [[ "$cs_tier" = escalated ]] && return 0
  [[ -n "$cs_files" ]] && [[ "$cs_churn" -gt "$threshold" ]]
}

written_paths() {
  local base="$1" mine="$2" to="${3:-}"
  {
    git -c core.quotePath=false diff --name-only "$base" ${to:+"$to"} 2>/dev/null
    [[ -n "$to" ]] || git -c core.quotePath=false ls-files --others --exclude-standard 2>/dev/null
  } | attributed_to "$mine"
}

sensitive_match() {
  local base="$2" mine="$3" to="${4:-}" written match rc=0 err why
  written=$(written_paths "$base" "$mine" "$to")
  [[ -n "$written" ]] || return 0
  err="$(mktemp 2>/dev/null)" || err=/dev/null
  local -a narrowing=(--narrowed-from "$base" --narrowed-from HEAD)
  [[ -z "$to" ]] || narrowing=(--narrowed-from "$base" --narrowed-to "$to")
  match=$(printf '%s\n' "$written" |
    node "$CS_MATCHER" --stdin "${narrowing[@]}" 2>"$err") || rc=$?
  why="$(head -c "${GL_DETAIL_MAX:-300}" "$err" 2>/dev/null | tr '\n' ' ')"
  [[ "$err" = /dev/null ]] || rm -f "$err"
  case "$rc" in
    0) ;;
    3)
      cs_fault="the declaration at $base, ${to:-HEAD or the working copy} did not read — a narrowing of it checked only as far as it read: $why"
      ;;
    *)
      cs_fault="lib/sensitive-paths.js failed — sensitive paths not checked, standard tier assumed: $why"
      return 0
      ;;
  esac
  local filter='select(.tier == "escalated") | (.matched | length), .matched[].name, .matched[].paths[]'
  printf '%s' "$match" | jq -e . >/dev/null 2>&1 || {
    cs_fault="jq could not read lib/sensitive-paths.js's output — sensitive paths not checked, standard tier assumed"
    return 0
  }
  local -a out=()
  mapfile -t out < <(printf '%s' "$match" | jq -r "$filter" 2>/dev/null)
  local n="${out[0]:-0}"
  [[ "${#out[@]}" -gt $((n + 1)) ]] || return 0
  cs_area_names=("${out[@]:1:n}")
  mapfile -t "$1" < <(printf '%s\n' "${out[@]:n+1}")
  cs_areas="$(join_comma "${cs_area_names[@]}")"
}

cs_log() { ! declare -F gl_log >/dev/null 2>&1 || gl_log "$1" 2>/dev/null; }

own_commits_owed() {
  local base="$1" newer="$2" mine="$3" sid="$4" own touched rc
  own="$(mktemp 2>/dev/null)" || {
    cs_log "could not make a temporary file — the whole ledger billed for the marker's newer base="
    code_review_owed "$base" "$mine" "$ANY_CHANGE" "$newer"
    return
  }
  if touched="$(node "$CS_ARBITER" own-paths "$base" "$newer" "$sid" 2>/dev/null)"; then
    printf '%s\n' "$touched" | attributed_to "$mine" >"$own"
  else
    cs_log "session-arbiter.js own-paths failed — the whole ledger billed for the marker's newer base="
    cp "$mine" "$own"
  fi
  code_review_owed "$base" "$own" "$ANY_CHANGE" "$newer"
  rc=$?
  rm -f "$own"
  return "$rc"
}

review_uncovered() {
  local marker="$1" base="$2" mine="$3" threshold="$4" sid="$5" to="${6:-}" valid=1 rc newer_base unseen=""
  pass_valid "$marker" "$base"
  rc=$?
  cs_pass_fault="${pass_fault?}" newer_base="${pass_base?}"
  local whole_change_hint="one of the session's whole change sets base=$base, its start point, and names every path this session wrote in paths="
  if [[ "$rc" -eq 0 ]] && marker_has "$marker" tree && ! marker_has "$marker" paths; then
    cs_pass_fault="it has a tree= line and no paths= line, so it records a staged review and nothing bounds what it vouches for: a staged review names every path its diff named in paths=, and $whole_change_hint"
  elif [[ "$rc" -eq 0 ]]; then
    valid=0
  elif [[ "$rc" -eq 2 ]] && ! own_commits_owed "$base" "$newer_base" "$mine" "$sid"; then
    if marker_has "$marker" paths; then
      valid=0
      cs_pass_fault=""
    else
      cs_pass_fault="its base= is ahead of this session's start point and it has no paths= line, so nothing bounds what it vouches for: a review of only some paths names them in paths=, and $whole_change_hint"
    fi
  fi
  if [[ "$valid" -eq 0 ]] && marker_has "$marker" paths; then
    if ! unseen="$(mktemp 2>/dev/null)"; then
      cs_log "could not make a temporary file — the marker's paths= not checked"
    elif
      marker_unlisted "$marker" paths <"$mine" >"$unseen" 2>/dev/null
      [[ $? -eq 2 ]]
    then
      cs_log "could not filter the write ledger by the marker's paths= — not checked"
    elif code_review_owed "${newer_base:-$base}" "$unseen" "$ANY_CHANGE" "$to"; then
      valid=1
      cs_pass_fault="its paths= leaves out ${cs_files% }, which this session wrote and the review it records never saw: a review of them adds them to paths=, and $whole_change_hint"
    fi
    [[ -z "${unseen:-}" ]] || rm -f "$unseen"
  fi
  code_review_owed "$base" "$mine" "$threshold" "$to"
  rc=$?
  [[ -z "$cs_fault" ]] || cs_log "$cs_fault"
  [[ "$rc" -eq 0 ]] || return 1
  if [[ "$cs_tier" = escalated ]]; then
    cs_tier_line="The \`escalated\` review tier is owed: this change touches declared sensitive paths (${cs_areas}), which owe it at any size and in any file type (#1618)."
    cs_marker_more=" On this escalated change, record it with --tier escalated (or mission-critical) --areas '${cs_areas}' as well, or it counts as no review."
    if [[ "$valid" -eq 0 ]]; then
      cs_pass_fault="$(marker_tier_fault "$marker" "${cs_area_names[@]}")" ||
        cs_log "could not read the marker's areas= against the areas touched — not checked"
      [[ -n "$cs_pass_fault" ]] || return 1
    fi
    return 0
  fi
  cs_tier_line="The \`standard\` review tier is owed."
  cs_marker_more=""
  [[ "$valid" -ne 0 ]]
}
