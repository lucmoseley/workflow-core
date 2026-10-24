#!/usr/bin/env bash
# PreToolUse guard: refuse, once per command, an `rm` Claude Code's built-in
# removal check cannot resolve, naming the two spellings that never meet it
# (workflow-core#2436).
#
# WHY A REFUSAL. That check denies before any allow entry is read, so no
# `permissions.allow` line clears it, and in away mode or a headless session
# nobody answers its prompt: the call is denied or the session stalls (workflow-core#2360).
# A PreToolUse deny fires before the check, costing one tool call.
#
# THE THREE LIMBS, each a shape the harness's own denial text names (census on
# workflow-core#2436):
#
#   var-slash   a target opening on a variable followed by `/` — `$T/*`,
#               `"$S/$f"`, `${D}/x` — where any variable in it is one the
#               command never assigned a value the walker resolves; a `$(…)`
#               value counts as unassigned, and the harness denies that too
#               ("when $T is unset or empty it becomes /").
#   cd-glob     a relative glob target after a `cd` in the same command ("the
#               relative glob target cannot be statically resolved").
#   shell       an `rm` anywhere in a command that also runs `bash`/`sh`/`zsh`
#               on a `-c` script or a script named by a variable ("passes a
#               shell -c script that runs rm, and Claude Code could not check
#               the script"). Here the check refuses even a literal target.
#
# REFUSE-ONCE, NOT DENY. The harness resolves most of what each limb catches
# (rates on workflow-core#2436), so this is an inference, and on workflow-core#1728's precedent a re-send
# of the same command goes through. The once is keyed on
# the command's hash, per (agent, session).
#
# WHAT IT LEAVES ALONE, as probes on workflow-core#2436 passed them: a bare `rm -rf $T`, a
# loop's `rm "$f"` and a literal-assigned `$R/$S/a`.
#
# It is narrowed to `if: Bash(*rm *)`, unanchored because the `if` tests quoted
# argument text, where a `bash -c` script's `rm` sits, and splits on `;` but
# not on a loop's `do`, so an anchored arm misses `for …; do rm …; done`.
#
# LIMITS
#  - The harness's trigger for the shell limb is unpublished and probes did not
#    pin it, so this limb over-fires by design, refusing once even
#    `bash -c 'rm -rf "$x"'`.
#  - A command substitution as the target (`rm $(…)`) and a target removing a
#    workspace directory (the cwd or a parent), the harness's other two
#    reasons, are not read.
#  - It fails open, on the record, on anything gp_begin or the latch cannot
#    resolve.

set -uo pipefail

here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null

# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null
declare -F gp_begin >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-parse.sh did not load — every command allowed unchecked"
  exit 0
}

gp_begin '.tool_input.command' command

# The first target each limb caught, as the refusal quotes it.
var_slash=""
cd_glob=""
shell_run=""
rm_seen=0
cd_seen=0
# Names an `export`/`declare`/`readonly` gave a literal value, which the walk's
# own harvest reads only off a command's leading assignments.
declare -A declared=()

# Is every `$NAME` in $1 one the command assigned a resolvable value?
all_assigned() {
  local rest="$1" name
  while [[ "$rest" =~ \$\{?([A-Za-z_][A-Za-z0-9_]*) ]]; do
    name="${BASH_REMATCH[1]}"
    gp_assigned "$name" || [[ -n "${declared[$name]+set}" ]] || return 1
    rest="${rest#*"${BASH_REMATCH[0]}"}"
  done
}

judge_rm() {
  local word lit opts=1
  rm_seen=1
  for word in "$@"; do
    if ((opts)); then
      [[ "$word" == -- ]] && {
        opts=0
        continue
      }
      [[ "$word" == -* ]] && continue
    fi
    lit="$(gp_literal "$word")" || :
    if [[ -z "$var_slash" && "$lit" =~ ^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/ ]] &&
      ! all_assigned "$lit"; then
      var_slash="$lit"
    fi
    if ((cd_seen)) && [[ -z "$cd_glob" && "$lit" != /* && "$lit" != '$'* && "$lit" == *[*?[]* ]]; then
      cd_glob="$lit"
    fi
  done
}

# One shell interpreter's words after the command word: the `-c` script, or
# the script file where it is named by a variable. A `-o`/`+o` takes a value.
judge_shell() {
  local lit dash_c=0
  while (($#)); do
    case "$1" in
      -o | +o) shift ;;
      --*) ;;
      -*c*) dash_c=1 ;;
      -* | +*) ;;
      *)
        lit="$(gp_literal "$1")" || :
        if ((dash_c)); then
          shell_run="-c"
          [[ "$lit" =~ (^|[[:space:]\;\&\|\(])rm[[:space:]] ]] && rm_seen=1
        elif [[ "$lit" == *'$'* ]]; then
          shell_run="$lit"
        fi
        return 0
        ;;
    esac
    (($#)) && shift
  done
}

judge_declare() {
  local word
  for word in "$@"; do
    [[ "$word" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    gp_literal "${BASH_REMATCH[2]}" >/dev/null && declared[${BASH_REMATCH[1]}]=1
  done
}

judge() {
  shift
  gp_unwrap "$@"
  set -- ${_gp_unwrapped+"${_gp_unwrapped[@]}"}
  (($#)) || return 0
  local base
  base="$(gp_literal "$1")" || return 0
  base="${base##*/}"
  shift
  case "$base" in
    rm) judge_rm "$@" ;;
    cd) cd_seen=1 ;;
    bash | sh | zsh | dash) [[ -n "$shell_run" ]] || judge_shell "$@" ;;
    export | declare | typeset | readonly | local) judge_declare "$@" ;;
  esac
  return 0
}

gp_walk_commands judge

reason=""
if [[ -n "$var_slash" ]]; then
  reason="its target \`$var_slash\` opens on a variable, and holds one this command never sets, so the check reads it as \`/\` when that variable is empty"
elif [[ -n "$cd_glob" ]]; then
  reason="its target \`$cd_glob\` is a relative glob after a \`cd\`, which the check cannot resolve"
elif ((rm_seen)) && [[ -n "$shell_run" ]]; then
  reason="it runs \`rm\` beside a shell running \`$shell_run\`, a script the check cannot read, so it refuses every \`rm\` in the command, a literal one included"
fi
[[ -n "$reason" ]] || gp_allow

# The once: a re-send of the same command is the escape (workflow-core#1728). Sixteen hex
# characters of the hash keep two commands in one session from sharing a latch
# at any count a session reaches.
latch="$(gp_latch_path "rm-unchecked.$(printf '%s' "$(gp_subject)" | sha1sum | cut -c1-16)")" ||
  gl_open "latch path unresolved — an unchecked rm allowed unrefused"
[[ -f "$latch" ]] && gp_allow
# A latch that cannot be written would refuse every re-send, so refuse nothing.
[[ -w "$(dirname "$latch")" ]] ||
  gl_open "latch directory unwritable — an unchecked rm allowed unrefused"

IFS= read -r -d '' refusal <<EOF || :
Refused once: Claude Code's built-in removal check would prompt on this command — $reason. Re-send it unchanged and it goes through to that check.

$(gp_rule_text rm-unchecked "An rm Claude Code cannot check is a permission prompt no allow entry clears; the rule could not be read from docs/agents/rules/rm-unchecked.txt. Read that file before re-sending.")
EOF

# EMIT, THEN LATCH (mantahostels#2261): a hook cancelled at its ceiling has its
# stdout discarded, and a latch written first would let the re-send through
# with nothing said.
gp_deny_context "$refusal" ||
  gl_open "the refusal did not render — an unchecked rm allowed unrefused"
: >"$latch" 2>/dev/null || gl_log "latch unwritable — this command will be refused again"
exit 0
