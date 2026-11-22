#!/usr/bin/env bash
_wc_here="${BASH_SOURCE[0]%/*}"
[[ "$_wc_here" == "${BASH_SOURCE[0]}" ]] && _wc_here=.
if ! declare -F gr_root >/dev/null 2>&1; then
  # shellcheck source=scripts/lib/guard-root.sh
  source "$_wc_here/guard-root.sh"
fi
unset _wc_here

WFC_KNOWN_CONTRACTS="1"
WFC_KNOWN_MODULES="roadmap governance site mutation comments"
WFC_KNOWN_DEPLOYS="vercel"
WFC_KNOWN_COMMANDS="test lint typecheck check check_staged helper_check full_test"
WFC_CONFIG_REL=".claude/workflow-core.json"

wfc_config_file() {
  printf '%s/%s' "$(gr_root)" "$WFC_CONFIG_REL"
}

_WFC_REFUSED=$'\x01contract '
_WFC_JQ_DEFS='def wfc_contract_gated(f): if type == "object" and has("contract") and (.contract as $c | $wfc_contracts | index([$c]) | not) then "\u0001contract " + (.contract | tojson) else f end;
def wfc_blank: test("[^\\t\\n\\x0B\\f\\r \\x{A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}]") | not;
'

_wfc_jq() {
  local file filter="$1"
  shift
  file="$(wfc_config_file)"
  [[ -f "$file" ]] || {
    printf 'null'
    return 0
  }
  if ! command -v jq >/dev/null 2>&1; then
    [[ -n "${_wfc_nojq_said:-}" ]] ||
      printf 'WARN %s: jq not found — every workflow-core key read as its default\n' "$file" >&2
    _wfc_nojq_said=1
    return 3
  fi
  jq -c "$@" --argjson wfc_contracts "[${WFC_KNOWN_CONTRACTS// /,}]" "$_WFC_JQ_DEFS$filter" "$file" 2>/dev/null || {
    printf 'WARN %s: does not parse — every key read as its default\n' "$file" >&2
    return 3
  }
}

wfc_contract_ok() {
  local out
  out="$(_wfc_jq 'wfc_contract_gated(empty)' -r)" || return 0
  [[ "$out" == "$_WFC_REFUSED"* ]] || return 0
  _wfc_contract_refusal "${out#"$_WFC_REFUSED"}"
  return 2
}

_wfc_contract_refusal() {
  printf '%s declares contract %s, which this workflow-core does not read (it reads %s). Read the migration note in migrations/ of the workflow-core release that set it — its *Residue* section names the contract — then pin that release or run its upgrade.\n' \
    "$(wfc_config_file)" "$1" "${WFC_KNOWN_CONTRACTS// /, }" >&2
}

_wfc_refused() {
  [[ "$1" == "$_WFC_REFUSED"* ]] || return 1
  [[ -n "${_wfc_contract_said:-}" ]] || _wfc_contract_refusal "${1#"$_WFC_REFUSED"}"
  _wfc_contract_said=1
}

wfc_module_on() {
  if [[ " $WFC_KNOWN_MODULES " != *" $1 "* ]]; then
    printf 'WARN wfc_module_on: unknown module "%s" (known: %s)\n' "$1" "$WFC_KNOWN_MODULES" >&2
    return 1
  fi
  local out on=false listed from="WFC_MODULES"
  if [[ -n "${WFC_MODULES+set}" ]]; then
    out="$(_wfc_jq 'wfc_contract_gated(empty)' -r)" || return 1
    ! _wfc_refused "$out" || return 1
    listed="$WFC_MODULES"
    [[ ",$listed," != *",$1,"* ]] || on=true
  else
    from="$WFC_CONFIG_REL"
    out="$(_wfc_jq 'wfc_contract_gated((.modules? // []) | if type == "array" then (any(.[]; . == $m) | tostring) + " " + (map(strings) | join(",")) else "false " end)' -r --arg m "$1")" || return 1
    ! _wfc_refused "$out" || return 1
    [[ "$out" != null ]] || return 1
    on="${out%% *}"
    listed="${out#* }"
  fi
  if [[ -z "${_wfc_unknown_modules_said:-}" ]]; then
    _wfc_unknown_modules_said=1
    local m ms
    IFS=, read -ra ms <<<"$listed"
    for m in "${ms[@]}"; do
      [[ -z "$m" || " $WFC_KNOWN_MODULES " == *" $m "* ]] ||
        printf 'WARN unknown module "%s" in %s\n' "$m" "$from" >&2
    done
  fi
  [[ "$on" == true ]]
}

wfc_command() {
  if [[ " $WFC_KNOWN_COMMANDS " != *" $1 "* ]]; then
    printf 'WARN wfc_command: unknown command "%s" (known: %s)\n' "$1" "$WFC_KNOWN_COMMANDS" >&2
    return 1
  fi
  local cmd
  cmd="$(_wfc_jq 'wfc_contract_gated((.commands? // {}) | if type == "object" then (.[$c] // "") else "" end | if type == "string" and (wfc_blank | not) then . else "" end)' -r --arg c "$1")" || return 1
  ! _wfc_refused "$cmd" || return 1
  [[ -n "$cmd" && "$cmd" != null ]] || return 1
  printf '%s' "$cmd"
}

wfc_deploy() {
  local d
  d="$(_wfc_jq 'wfc_contract_gated(.deploy? // "" | if type == "string" then . else "" end)' -r)" || return 1
  ! _wfc_refused "$d" || return 1
  [[ -n "$d" && " $WFC_KNOWN_DEPLOYS " == *" $d "* ]] || return 1
  printf '%s' "$d"
}

wfc_suite_runners() {
  local out
  out="$(_wfc_jq 'wfc_contract_gated((.suiteRunners? // []) | if type == "array" and all(type == "string") then .[] else empty end)' -r)" || return 1
  ! _wfc_refused "$out" || return 0
  [[ -n "$out" && "$out" != null ]] || return 0
  printf '%s\n' "$out"
}

wfc_polled() {
  local out
  out="$(_wfc_jq 'wfc_contract_gated((.polled? // []) | if type == "array" and all(type == "string" and . != "" and (startswith("/") | not) and (split("/") | map(split("\\")[]) | index("..") | not)) then .[] else empty end)' -r)" || return 1
  ! _wfc_refused "$out" || return 0
  [[ -n "$out" && "$out" != null ]] || return 0
  printf '%s\n' "$out"
}

wfc_tracker() {
  local t url name
  t="$(_wfc_jq 'wfc_contract_gated(.tracker? | if type == "string" then "=" + . else "" end)' -r)" || t=""
  ! _wfc_refused "$t" || t=""
  if [[ "$t" == =* ]]; then
    printf '%s' "${t#=}"
    return 0
  fi
  url="$(git -C "$(gr_root)" config --get remote.origin.url 2>/dev/null)" || return 1
  url="${url#"${url%%[![:space:]]*}"}"
  url="${url%"${url##*[![:space:]]}"}"
  [[ "$url" =~ ^(https?://([^@/]+@)?github\.com/|git@github\.com:|ssh://git@github\.com/)([^/[:space:]]+)/([^/[:space:]]+)/?$ ]] || return 1
  name="${BASH_REMATCH[4]}"
  [[ "$name" == .git ]] || name="${name%.git}"
  printf '%s/%s' "${BASH_REMATCH[3]}" "$name"
}

wfc_repo_slug() {
  local r="${1,,}"
  r="${r#*://}"
  r="${r#git@}"
  r="${r/#github.com:/github.com/}"
  r="${r#github.com/}"
  r="${r%/}"
  r="${r%.git}"
  printf '%s' "$r"
}

wfc_output_style() {
  local style norm
  if [[ -n "${WFC_OUTPUT_STYLE+set}" ]]; then
    style="$WFC_OUTPUT_STYLE"
  else
    style="$(_wfc_jq 'wfc_contract_gated(.overrides?.output_style? // "" | if type == "string" then . else "" end)' -r 2>/dev/null)" || style=""
    norm="${style//\\//}"
    [[ "$style" != null && "$style" != "$_WFC_REFUSED"* && "$norm" == */* && "$style" != /* && "/$norm/" != */../* ]] || style=""
  fi
  [[ -z "${WFC_OUTPUT_STYLE:-}" ]] || wfc_contract_ok 2>/dev/null || style=""
  printf '%s' "${style:-.claude/output-styles/core-voice.md}"
}

wfc_core_voice_loaded() {
  local root style cfg
  root="$(gr_root)"
  gr_config_dir cfg
  style="$(jq -rn 'first(inputs | objects | .outputStyle | strings) // ""' \
    "$root/.claude/settings.local.json" "$root/.claude/settings.json" \
    "$cfg/settings.json" 2>/dev/null)"
  [[ "$style" == "Core voice" || "$style" == "workflow-core:Core voice" ]]
}

wfc_disabled() {
  local file text
  file="$(wfc_config_file)"
  [[ -f "$file" ]] || return 1
  text="$(<"$file")"
  [[ "$text" == *'"disabled"'* ]] || return 1
  local hit
  hit="$(_wfc_jq 'wfc_contract_gated((.disabled? // []) | if type == "array" and all(type == "string") then index($b) != null else false end)' --arg b "$1")" || return 1
  [[ "$hit" == true ]]
}

wfc_module_off_line() {
  printf 'SKIP: module "%s" is off — %s does not list it under "modules"\n' "$1" "$WFC_CONFIG_REL"
}

wfc_command_undeclared_line() {
  printf 'SKIP: commands.%s is undeclared in %s\n' "$1" "$WFC_CONFIG_REL"
}
