#!/usr/bin/env bash
# The adopter config, `.claude/workflow-core.json` at the host root, read from
# shell (#2). The JS half is scripts/lib/workflow-core-config.js; the two answer
# every key alike, so change both or neither: wfc-config.test.ts's parity table
# runs each fixture through both to hold them to it (#1481). A contract this
# core does not read is refused as the JS reader refuses it, but the key reads
# as its default, the refusal on stderr: a hook must not exit 2.
#
# SOURCED, NEVER RUN. Needs gr_root (lib/guard-root.sh), sourced here if absent,
# and jq. WITHOUT jq EVERY READ ANSWERS ITS DEFAULT — no module on, no command
# declared, nothing disabled — and says so once on stderr, so a missing jq skips
# gated checks rather than running them against a host that never opted in.
#
# Unknown-key warnings are the JS reader's alone: shell reads a key at a time,
# and repeating the whole-file audit on every guard call would cost a jq fork
# per hook.

if ! declare -F gr_root >/dev/null 2>&1; then
  # shellcheck source=scripts/lib/guard-root.sh
  source "$(dirname "${BASH_SOURCE[0]}")/guard-root.sh"
fi

WFC_KNOWN_CONTRACTS="1"
# The JS reader's MODULES, in its order; wfc-config.test.ts pins the two equal.
WFC_KNOWN_MODULES="roadmap governance suites site mutation landing"
# The JS reader's DEPLOYS; wfc-config.test.ts pins the two equal.
WFC_KNOWN_DEPLOYS="vercel"
# The JS reader's COMMANDS; wfc-config.test.ts pins the two equal.
WFC_KNOWN_COMMANDS="test lint typecheck check check_staged push_check helper_check full_test"
WFC_CONFIG_REL=".claude/workflow-core.json"

wfc_config_file() {
  printf '%s/%s' "$(gr_root)" "$WFC_CONFIG_REL"
}

# wfc_contract_gated(f) is f, unless the config declares a contract this core does not read — null or a string
# included, as contractOf() refuses them — where it is _WFC_REFUSED and that
# contract.
# wfc_blank is the JS reader's empty-after-trim(), on trim()'s own whitespace.
_WFC_REFUSED=$'\x01contract '
_WFC_JQ_DEFS='def wfc_contract_gated(f): if type == "object" and has("contract") and (.contract as $c | $wfc_contracts | index([$c]) | not) then "\u0001contract " + (.contract | tojson) else f end;
def wfc_blank: test("[^\\t\\n\\x0B\\f\\r \\x{A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}]") | not;
'

# jq <filter> [<jq options>...] over the config, `null` where the file is
# absent. Returns 3 where jq is missing or the file does not parse, printing why.
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

# 0 where the contract is one this core reads, or absent. 2, with the refusal
# on stderr naming the migration notes, where it is not.
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

# 0 where a read answered wfc_contract_gated's refusal, printed here once per
# shell; the caller then reads its key as the default. A read run inside a
# command substitution is a shell of its own, so it says the refusal again.
_wfc_refused() {
  [[ "$1" == "$_WFC_REFUSED"* ]] || return 1
  [[ -n "${_wfc_contract_said:-}" ]] || _wfc_contract_refusal "${1#"$_WFC_REFUSED"}"
  _wfc_contract_said=1
}

# 0 where <module> is listed under "modules" — or, where WFC_MODULES is set,
# in that comma-separated list instead (the JS reader's test-injection point).
# An unknown <module> warns and reads as off: the JS reader throws on one, but
# a throw here would take down the hook calling it (#43). An unknown name in
# the list read warns once per process, as the JS reader does.
wfc_module_on() {
  if [[ " $WFC_KNOWN_MODULES " != *" $1 "* ]]; then
    printf 'WARN wfc_module_on: unknown module "%s" (known: %s)\n' "$1" "$WFC_KNOWN_MODULES" >&2
    return 1
  fi
  local out on=false listed from="WFC_MODULES"
  if [[ -n "${WFC_MODULES+set}" ]]; then
    # The config is still read, and an unreadable one or an unread contract
    # still reads off: the JS reader throws on both before the injection.
    out="$(_wfc_jq 'wfc_contract_gated(empty)' -r)" || return 1
    ! _wfc_refused "$out" || return 1
    listed="$WFC_MODULES"
    [[ ",$listed," != *",$1,"* ]] || on=true
  else
    from="$WFC_CONFIG_REL"
    # Matched in jq, so an entry holding a comma is never split in two; the
    # list after it is for the warning below.
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

# Prints commands.<name> and returns 0 where it is more than whitespace. An
# unknown <name> warns and reads as undeclared where the JS reader throws, as
# an unknown module reads off (#43, #1481).
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

# Prints "deploy" and returns 0 where it is one of WFC_KNOWN_DEPLOYS (#742).
wfc_deploy() {
  local d
  d="$(_wfc_jq 'wfc_contract_gated(.deploy? // "" | if type == "string" then . else "" end)' -r)" || return 1
  ! _wfc_refused "$d" || return 1
  [[ -n "$d" && " $WFC_KNOWN_DEPLOYS " == *" $d "* ]] || return 1
  printf '%s' "$d"
}

# Prints each "suiteRunners" entry, one per line (#330) — none where any entry
# is not a string, as the JS reader drops the whole key.
wfc_suite_runners() {
  local out
  out="$(_wfc_jq 'wfc_contract_gated((.suiteRunners? // []) | if type == "array" and all(type == "string") then .[] else empty end)' -r)" || return 1
  ! _wfc_refused "$out" || return 0
  # `null` is _wfc_jq's answer for an absent config.
  [[ -n "$out" && "$out" != null ]] || return 0
  printf '%s\n' "$out"
}

# Prints the declared "tracker", else the origin remote's owner/name as the JS
# reader's parseGithubRemote() parses it; returns 1 where neither resolves. A
# declared value that is not a string reads as undeclared.
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
  # The JS match is lazy and needs one character, so a bare `.git` stays.
  [[ "$name" == .git ]] || name="${name%.git}"
  printf '%s/%s' "${BASH_REMATCH[3]}" "$name"
}

# A github.com repo as gh accepts it — OWNER/REPO, github.com/OWNER/REPO, a URL
# or git@github.com:OWNER/REPO — reduced to lower-case owner/repo, so two
# spellings of one repo compare equal. Another host keeps its prefix, so reads
# as another repo.
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

# Prints overrides.output_style, else core-voice.md (#448) — the JS reader's
# outputStylePath(): its validation, its unread-contract default and its
# WFC_OUTPUT_STYLE injection included.
wfc_output_style() {
  local style norm
  if [[ -n "${WFC_OUTPUT_STYLE+set}" ]]; then
    style="$WFC_OUTPUT_STYLE"
  else
    style="$(_wfc_jq 'wfc_contract_gated(.overrides?.output_style? // "" | if type == "string" then . else "" end)' -r 2>/dev/null)" || style=""
    # Separators either way, as the JS split is; absolute on `/` alone, as
    # posix path.isAbsolute is.
    norm="${style//\\//}"
    [[ "$style" != null && "$style" != "$_WFC_REFUSED"* && "$norm" == */* && "$style" != /* && "/$norm/" != */../* ]] || style=""
  fi
  [[ -z "${WFC_OUTPUT_STYLE:-}" ]] || wfc_contract_ok 2>/dev/null || style=""
  printf '%s' "${style:-.claude/output-styles/core-voice.md}"
}

# 0 where the session's output style is Core voice (#2039): the first
# `outputStyle` in the harness's precedence, project-local, project, then user
# settings; managed settings are not read. lib/output-styles.js's CORE_STYLE
# and namespacing are the JS twin. check-output-style.js's SETTINGS
# omits the user file because it checks the project's own declaration.
wfc_core_voice_loaded() {
  local root style cfg
  root="$(gr_root)"
  gr_config_dir cfg
  style="$(jq -rn 'first(inputs | objects | .outputStyle | strings) // ""' \
    "$root/.claude/settings.local.json" "$root/.claude/settings.json" \
    "$cfg/settings.json" 2>/dev/null)"
  [[ "$style" == "Core voice" || "$style" == "workflow-core:Core voice" ]]
}

# 0 where <basename> is listed under "disabled". Fails to "not disabled".
wfc_disabled() {
  local file text
  file="$(wfc_config_file)"
  [[ -f "$file" ]] || return 1
  # A builtin read first: most configs name no "disabled" key, and this runs
  # on every guard call, so the jq fork is paid only where one is declared.
  text="$(<"$file")"
  [[ "$text" == *'"disabled"'* ]] || return 1
  # As in the JS reader, a contract this core does not read disables nothing,
  # and silently.
  local hit
  hit="$(_wfc_jq 'wfc_contract_gated((.disabled? // []) | if type == "array" and all(type == "string") then index($b) != null else false end)' --arg b "$1")" || return 1
  [[ "$hit" == true ]]
}

# The one skip line a module-gated check prints, on stderr, in the checker
# family's SKIP alphabet (mantahostels#155).
wfc_module_off_line() {
  printf 'SKIP: module "%s" is off — %s does not list it under "modules"\n' "$1" "$WFC_CONFIG_REL"
}

wfc_command_undeclared_line() {
  printf 'SKIP: commands.%s is undeclared in %s\n' "$1" "$WFC_CONFIG_REL"
}
