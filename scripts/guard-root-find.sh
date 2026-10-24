#!/usr/bin/env bash
# PreToolUse guard: refuse a `find` whose start point is `/`, at any depth, and
# hand over the cheaper routes (workflow-core#1006).
#
# WHY (workflow-core#1006, which carries the timings). Under WSL2 neither bound rescues a
# `find` started at `/`: `-maxdepth` does not, and `-xdev`, which skips
# `/mnt/c`, still timed out. So both are refused, deliberately.
#
# DENY, NOT WARN (workflow-core#1006 Q1). 65 of 83 sessions made exactly one such call, and a
# warn cannot stop the call it fires on, so it would spare almost none of them.
# The cost is wall time, paid in every permission mode, which is what separates
# this from workflow-core#482's warn on a recursive grep, whose cost was a prompt auto mode
# never shows.
#
# NO ESCAPE VARIABLE. Naming the roots is the route — `find /usr /opt /home` —
# and a self-spellable bypass would make the deny a warn (mantahostels#109).
#
# Its `if: Bash(*find *)` narrowing is unanchored, because the walker below
# strips launchers (`timeout 120 find /`) that an anchored arm would miss. A
# command holding `find` with no space after it never execs this.
#
# LIMITS
#  - A start point spelled with an unexpanded variable — `$HOME`, `"$dir"` — is
#    unread, and passes.
#  - `/` is recognised after collapsing `.`, `..` and doubled slashes, so `//`,
#    `/.` and `/..` are `/` too. A symlink to `/` is not followed.
#  - A RELATIVE start point, or none at all (`find` defaults to `.`), is
#    resolved against the walker's cwd — the payload's, moved by any `cd`
#    before it. So `cd / && find . -name x` is refused, and a session standing
#    in `/` is refused `find . -name x`. Where the cwd is unknown, it passes.
#  - The command word must be `find`, by basename, after the shared walker's
#    launcher unwrapping. `sh -c "find / …"`, a heredoc fed to a shell, `fd`,
#    `locate`, `du /`, `ls -R /` and `grep -r … /` are all unjudged (workflow-core#1006 out
#    of scope).
#  - It FAILS OPEN throughout, house style (mantahostels#103 §6), recording through
#    lib/guard-log.sh (mantahostels#147).

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

# The segment refused, kept for the reason's @CMD@.
refused=""

# is_root <start point> — true where the word names `/`.
is_root() {
  local lit cwd
  # Non-zero is an unexpanded variable or substitution: unreadable, so it passes.
  lit="$(gp_literal "$1")" || return 1
  case "$lit" in
    /*) ;;
    *)
      cwd="$(gp_cwd)"
      [[ "$cwd" == /* ]] || return 1
      lit="$cwd/$lit"
      ;;
  esac
  [[ "$(gp_norm_abs "$lit")" == / ]]
}

judge() {
  # Trailing whitespace off, for the reason's @CMD@.
  local segment="${1%"${1##*[![:space:]]}"}"
  shift
  [[ -z "$refused" ]] || return 0
  gp_unwrap "$@"
  ((${#_gp_unwrapped[@]})) || return 0
  [[ "${_gp_unwrapped[0]##*/}" == find ]] || return 0

  local start
  gp_find_starts "${_gp_unwrapped[@]:1}"
  for start in "${_gp_find_starts[@]:-.}"; do
    if is_root "$start"; then
      refused="$segment"
      return 0
    fi
  done
  return 0
}

gp_walk_commands judge

[[ -n "$refused" ]] || gp_allow

# The plugin's own root, literal: CLAUDE_PLUGIN_ROOT is not set in the Bash
# tool's environment, so a session hunting this plugin's scripts cannot spell it.
plugin_root="$(CDPATH='' cd -P -- "$here/.." 2>/dev/null && pwd)"
[[ "$plugin_root" == /* ]] ||
  gl_open "the plugin root did not resolve — a find at / was allowed"

IFS= read -r -d '' reason <<EOF || :
Refused: \`@CMD@\` starts at \`/\`. A find over the whole disk under WSL2 ran to the 2-minute timeout in about half of 114 measured calls, and neither \`-maxdepth\` nor \`-xdev\` saved it (workflow-core#1006). Cheapest route first:

1. This plugin's own files: $plugin_root — its scripts/ and docs/agents/ are there.
2. The repo's scratch, .claude/tmp/, and the repo itself.
3. Named roots: \`find /usr /opt /home -xdev -name …\`. Name /mnt/c only when the Windows disk is meant.

\`~\` and \$HOME are cheap (median 5 s) and pass.
EOF
gp_deny "$reason" "$refused"
