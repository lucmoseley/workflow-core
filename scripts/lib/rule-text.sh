#!/usr/bin/env bash
# rule-text.sh — the bash half of the rule-text store (mantahostels#1644, spec mantahostels#1641).
#
# Twin of scripts/lib/rule-text.js. Read that file's header for why the store
# exists and why it is plain text rather than JSON.
#
# TWO WAYS IN, deliberately:
#
#   source "$here/lib/rule-text.sh"             # a guard, which wants the function
#   scripts/lib/rule-text.sh commit-pathspec ... # a session, which wants stdout
#
# A guard sources it and calls `rule_text <id>`, splicing the result into its
# deny reason. Sourcing must never exit the caller, so `rule_text` RETURNS 1 on
# an unknown id rather than exiting — a guard that fails open in the house style
# (mantahostels#103) needs the chance to. `rule_text` itself stays single-id.
#
# The CLI form takes an id LIST (mantahostels#2494) — a session fetching several rules
# resolves them in one Bash call rather than one per rule. One argument prints
# the bare fragment. Two or more print each fragment under a "## <id>" heading,
# blank-line separated, and every id is resolved before anything is printed:
# one unknown id anywhere in the list refuses and exits 1.
#
# An id may be given BARE or with a leading `rule:` — the spelling the trigger
# indexes and CLAUDE.md quote ids in (mantahostels#2707). `--ids` enumerates the bare form
# only.
#
# `--ids` is recognised only as the SOLE or FIRST argument (it enumerates and
# exits before any id resolution runs). Elsewhere in the list it is just
# another id — and an invalid one, refusing rather than enumerating, since no
# rule is spelled "--ids".
#
# The refusal goes to stderr and the text to stdout, so a caller that captures
# `$(rule_text <id>)` gets the text or nothing, never a diagnostic spliced into a
# session's refusal message.
#
# WFC_RULES_DIR redirects the store, for tests only; with it set,
# WFC_RULES_FALLBACK_DIR is the only layer beneath it (rt_dirs).
#
# IT SOURCES NEITHER lib/guard-log.sh NOR lib/guard-parse.sh: this reads one file
# and has no hook envelope, so it stays free of both and can be sourced by a
# non-guard. The dependency runs the other way — guard-parse.sh's gp_rule
# sources THIS, lazily, at its first call (mantahostels#1804). It DOES source
# lib/guard-root.sh and lib/script-path.sh, which have no state and no
# dependencies of their own, so the rule holds.

# This file's directory without forking `dirname` — `.` where the CLI form was
# run by a bare name, as dirname would answer.
_RT_HERE="${BASH_SOURCE[0]%/*}"
[[ "$_RT_HERE" == "${BASH_SOURCE[0]}" ]] && _RT_HERE=.

# shellcheck source=scripts/lib/guard-root.sh
source "$_RT_HERE/guard-root.sh"
# shellcheck source=scripts/lib/script-path.sh
source "$_RT_HERE/script-path.sh" 2>/dev/null

# Resolved once, at source, so no call forks (workflow-core#653).
_RT_CORE_DIR="$(cd "$_RT_HERE/../.." && pwd)/docs/agents/rules"
_RT_CONFIG_JS="$(cd "$_RT_HERE" && pwd)/workflow-core-config.js"

# The HOST repo's root, through the one seam (workflow-core#1). `$_RT_HERE`
# stays for finding guard-root.sh itself, a sibling that ships with this file —
# but never for the store, which belongs to the host: two levels up from here is
# the PLUGIN root in a plugin install, where the session found an empty rule
# store and fell back to the plugin's own copy (finding F24 of the adoption dry
# run).
rt_root() {
  gr_root
}

# The store directory in force, read at call time so a test can set it per case.
# The host's own store first, then the CORE's: an adopter never copies the
# fragments, so a guard firing there prints its rule out of the plugin root
# (workflow-core#5). Keep it in step with lib/rule-text.js's rulesDir().
rt_dir() {
  if [[ -n "${WFC_RULES_DIR:-}" ]]; then
    rt_resolve "$WFC_RULES_DIR"
  elif [[ -d "$(rt_root)/docs/agents/rules" ]]; then
    rt_resolve "$(rt_root)/docs/agents/rules"
  else
    rt_core_dir
  fi
}

# $1 made absolute and normalised LEXICALLY, symlinks untouched — what Node's
# path.resolve does, so rt_dirs dedupes and names the layers rulesDirs() would.
# Pure bash: GNU `realpath -ms` is no portable spelling of it.
rt_resolve() {
  local p="$1" part
  # rt_-prefixed: guard-parse.sh sources this file with shellcheck's -x, which
  # flattens the two files' namespaces, so a bare `out` here reads as the same
  # name as guard-parse.sh's unrelated scalar locals (SC2178/SC2128).
  local -a parts rt_out=()
  [[ "$p" == /* ]] || p="$PWD/$p"
  IFS=/ read -ra parts <<<"$p"
  for part in "${parts[@]}"; do
    case "$part" in
      '' | .) ;;
      ..) [[ ${#rt_out[@]} -gt 0 ]] && unset 'rt_out[${#rt_out[@]}-1]' ;;
      *) rt_out+=("$part") ;;
    esac
  done
  local IFS=/
  printf '/%s' "${rt_out[*]}"
}

# The CORE's own store, beside this file: the plugin root's in an adopter.
rt_core_dir() {
  printf '%s' "$_RT_CORE_DIR"
}

# The CORE's layer as rt_dirs takes it — lib/rule-text.js's coreLayer(). Prints
# nothing under an override naming no fallback.
rt_core_layer() {
  if [[ -n "${WFC_RULES_DIR:-}" ]]; then
    [[ -n "${WFC_RULES_FALLBACK_DIR:-}" ]] || return 0
    rt_resolve "$WFC_RULES_FALLBACK_DIR"
  else
    rt_resolve "$_RT_CORE_DIR"
  fi
}

# Every store an id is looked up in, one per line, first match winning: rt_dir,
# then the CORE's — layered, not either/or, so an adopter that generates one
# fragment of its own still prints every core guard's rule (workflow-core#97). Under the
# override the core layer is WFC_RULES_FALLBACK_DIR alone, never implied. Keep
# it in step with lib/rule-text.js's rulesDirs().
rt_dirs() {
  local primary core
  primary="$(rt_dir)"
  printf '%s\n' "$primary"
  core="$(rt_core_layer)"
  [[ -n "$core" && "$core" != "$primary" ]] && printf '%s\n' "$core"
  return 0
}

# Every rule id the stores hold, one per line, sorted bytewise as Node's sort()
# is. An absent layer is an empty store; one that exists but cannot be listed —
# unreadable, or a file — returns 1, as ruleIds() throws (mantahostels#103). One
# accepted divergence: a readable but unsearchable layer (0400) refuses here,
# where readdirSync lists it.
rule_ids() {
  local dir f id
  local -a ids=()
  while IFS= read -r dir; do
    [[ -e "$dir" ]] || continue
    if [[ ! -d "$dir" || ! -r "$dir" || ! -x "$dir" ]]; then
      printf 'rule-text: cannot read the store %s.\n' "$dir" >&2
      return 1
    fi
    for f in "$dir"/*.txt; do
      [[ -f "$f" ]] || continue
      id="$(basename "$f" .txt)"
      [[ "$id" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || continue
      ids+=("$id")
    done
  done < <(rt_dirs)
  [[ ${#ids[@]} -gt 0 ]] || return 0
  printf '%s\n' "${ids[@]}" | LC_ALL=C sort -u
}

# $1 with ONE leading `rule:` removed. Called before the grammar runs and before
# anything is joined onto a path, so `rule:../outside` becomes `../outside` and
# is refused as an id rather than resolved as one.
rt_bare_id() {
  printf '%s' "${1#rule:}"
}

# Print the operative text of rule $1.
rule_text() {
  local given="${1:-}" id dir file known layer=
  id="$(rt_bare_id "$given")"
  if [[ ! "$id" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
    printf 'rule-text: "%s" is not a rule id — ids are lowercase kebab-case.\n' \
      "$given" >&2
    return 1
  fi
  file="$(rt_dir)/$id.txt"
  while IFS= read -r dir; do
    if [[ -f "$dir/$id.txt" ]]; then
      file="$dir/$id.txt"
      layer="$dir"
      break
    fi
  done < <(rt_dirs)
  if [[ ! -f "$file" ]]; then
    known="$(rule_ids | paste -sd, - 2>/dev/null | sed 's/,/, /g')"
    known="${known:+Known ids: $known.}"
    printf 'rule-text: no fragment for rule id "%s" (looked in %s). %s\n' \
      "$id" "$(rt_dirs | paste -sd, - | sed 's/,/, /g')" \
      "${known:-The store holds no fragments.}" >&2
    return 1
  fi
  local body
  # Command substitution already strips every trailing newline; printf puts none
  # back, so the two accessors agree byte for byte.
  body="$(<"$file")"
  # An empty fragment is the failure this store exists to prevent, arriving by
  # the one route the id check cannot see.
  if [[ -z "${body//[[:space:]]/}" ]]; then
    printf 'rule-text: the fragment for rule id "%s" (%s) is empty. A guard printing it would deny a session and state no rule.\n' \
      "$id" "$file" >&2
    return 1
  fi
  # A fragment names core scripts as `scripts/x`; an install serves them
  # through the plugin root (workflow-core#343), as rule-text.js does.
  local text="$body"
  if declare -F resolve_script_paths >/dev/null; then
    text="$(printf '%s' "$body" | resolve_script_paths | expand_paste_paths "$(rt_root)")"
  fi
  # A core fragment's bare `#N` is qualified in an install (workflow-core#416), through the
  # JS qualifier itself so the twins cannot drift — at the price of one node
  # start per fragment printed there. Where node fails, the text prints
  # unqualified rather than not at all.
  local qualified
  if declare -F sp_in_checkout >/dev/null && ! sp_in_checkout &&
    [[ "$layer" == "$(rt_core_layer)" ]] &&
    qualified="$(printf '%s' "$text" |
      node "$_RT_HERE/qualify-citations.js" 2>/dev/null)"; then
    text="$qualified"
  fi
  [[ "$text" != *"{command:"* ]] || text="$(_rt_expand_commands "$text")"
  printf '%s' "$text"
}

# rule-text.js's expandCommands (workflow-core#742): `{command:<name>}` becomes the host's
# declared commands.<name>, or push_check's default (workflow-core#814), and a line naming
# one with neither is dropped whole. Built left to right, so a command holding the placeholder's own
# spelling is never expanded again. A config that does not parse declares
# nothing, and _wfc_jq says so on stderr.
_RT_COMMAND_RE='\{command:([a-z_]+)\}'
_rt_expand_commands() {
  if ! declare -F wfc_command >/dev/null 2>&1; then
    # shellcheck source=scripts/lib/wfc-config.sh
    source "$_RT_HERE/wfc-config.sh" 2>/dev/null || true
  fi
  local line rest pre cmd done_part out='' sep=''
  while IFS= read -r line; do
    rest="$line"
    done_part=''
    while [[ "$rest" =~ $_RT_COMMAND_RE ]]; do
      pre="${rest%%"${BASH_REMATCH[0]}"*}"
      # Undeclared push_check asks workflow-core-config.js's defaultCommand for
      # its value (workflow-core#1240), one node start per occurrence; no other name starts
      # node, so a default defaultCommand gains for another name is dropped
      # here until the condition below names it too — rule-text.test.ts's twin
      # check on every name catches the gap. Where node fails, the line is
      # dropped: a host that cannot start node cannot run push-check.js either.
      if ! cmd="$(wfc_command "${BASH_REMATCH[1]}")" &&
        ! { [[ "${BASH_REMATCH[1]}" == push_check ]] &&
          cmd="$(node -e 'const d = require(process.argv[1]).defaultCommand(process.argv[2]); if (!d) process.exit(1); process.stdout.write(d)' \
            "$_RT_CONFIG_JS" "${BASH_REMATCH[1]}" 2>/dev/null)"; }; then
        continue 2
      fi
      done_part+="$pre$cmd"
      rest="${rest:$((${#pre} + ${#BASH_REMATCH[0]}))}"
    done
    out+="$sep$done_part$rest"
    sep=$'\n'
  done <<<"$1"
  printf '%s' "$out"
}

# Run directly rather than sourced: the CLI form, where the refusal exits.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -euo pipefail
  if [[ "${1:-}" == "--ids" ]]; then
    rule_ids
    exit 0
  fi
  if [[ $# -eq 0 ]]; then
    printf 'usage: rule-text.sh <rule-id> [<rule-id>…] | --ids\n' >&2
    exit 2
  fi
  if [[ $# -eq 1 ]]; then
    rule_text "$1" || exit 1
    printf '\n'
    exit 0
  fi
  # A list: resolve every id before printing any of them, so one unknown id
  # anywhere in the list can never leave a prior fragment on stdout looking
  # like a complete, successful answer.
  # Ids are passed on AS GIVEN, so `rule_text` is the one place a `rule:` prefix
  # is stripped: baring them here too would strip twice, letting `rule:rule:x`
  # through on this path alone. The heading bares the id it already accepted, so
  # a list mixing the two spellings matches what `--ids` enumerates.
  ids=("$@")
  bodies=()
  for id in "${ids[@]}"; do
    body="$(rule_text "$id")" || exit 1
    bodies+=("$body")
  done
  for i in "${!ids[@]}"; do
    [[ $i -eq 0 ]] || printf '\n'
    printf '## %s\n\n%s\n' "$(rt_bare_id "${ids[$i]}")" "${bodies[$i]}"
  done
fi
