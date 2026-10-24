#!/usr/bin/env bash
# PreToolUse guard: this run may be executing a neighbour's half-written script
# (mantahostels#1035).
#
# Why: the working tree is repo-global, so `node scripts/x.js` runs the bytes on
# disk — mid-save bytes included — and `scripts/` is a detect-only claim tier
# (mantahostels#287), so an EXECUTION against a mid-edit file had no signal at all.
#
# WARN, NEVER DENY — mantahostels#103's line: deny on a structured fact where the action has
# no legitimate use, warn where the guard is inferring. The neighbour's edit may
# be finished-but-uncommitted, and no session may be blocked from running the
# repo's own tooling.
#
# A HOOK, NOT A CHECK INSIDE EACH SCRIPT — mantahostels#1035 left the choice open. An
# in-script check is cheaper and exact, but it covers only what opts in, and the
# hang that produced this ticket happened in a script that would not have opted
# in until after it hung. The price mantahostels#287 refused was parsing an OPEN-ENDED write
# — `cp`, `tee`, a redirect, a heredoc, an unbounded list of spellings. Reading
# which script a command RUNS is the bounded half of that problem: the first word
# of each command, and one word after an interpreter, with node started only for
# a command that names an existing script.
#
# This file finds the scripts a command runs; scripts/warn-stale-script.js
# decides and writes every word of the warning. The command line can only be read
# in bash, the claim store only in node.
#
# LIMITS
#  - It reads the PARSED command form, never a substring, so a grep, an echo or
#    a heredoc mentioning a script path passes. Quoted spans and heredoc bodies
#    are removed before parsing (lib/guard-parse.sh, mantahostels#123).
#  - The routes it knows are: a script run as the command itself, the first
#    script under node/bash/sh/zsh/python/python3/tsx/ts-node, and `npm`/`pnpm`
#    `run <name>` whose package.json body names scripts/ files. A script reached
#    any other way — a wrapper, `xargs`, `env`, `npm --prefix <dir> run <name>`,
#    a script another script runs — is not seen.
#  - A script named as an ARGUMENT is not a run: only the first word that is a
#    file is read, because everything after it belongs to that script.
#  - Relative paths resolve against the hook's cwd, so a `cd elsewhere && node
#    scripts/x.js` resolves to nothing and is passed unchecked. The file must
#    EXIST to become a candidate, which is what makes that failure silent rather
#    than a false warning.
#  - In a worktree the paths resolve outside the shared repo root and nothing
#    warns — right, because a worktree runs its own copy of the file.
#  - It FAILS OPEN throughout, house style (mantahostels#103 §6), and records the fail-opens
#    that matter through lib/guard-log.sh (mantahostels#147).
#  - The residual the warning itself states: a script left dirty under no claim
#    is invisible, because a Bash-route write mints no claim (mantahostels#364).

set -uo pipefail

# The shared parser (mantahostels#123), resolved from this file's own location because a
# hook runs with an arbitrary cwd. The gate is ONE name, gp_begin — never
# `source`'s exit status (mantahostels#157). guard-log.sh is sourced first and separately so
# the one fault that disarms this guard entirely is itself recordable (mantahostels#147).
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

# What the judge will be asked about: absolute script paths, and `npm run` names
# as npm-script:<name>. Filled by the walk below, which runs in this scope.
CANDIDATES=()

# One word, kept only if it names a file that exists. An unreadable word — an
# unexpanded $VAR, a command substitution — is dropped rather than guessed at.
# Non-zero means nothing was taken, which is how the caller below finds the first
# word that is a script and stops there.
add_path() {
  local word="$1" lit abs
  lit="$(gp_literal "$word")" || return 1
  [[ -n "$lit" && "$lit" != -* && "$lit" == */* ]] || return 1
  lit="${lit#./}" # so one spelling reaches the judge, not two
  [[ "$lit" == /* ]] && abs="$lit" || abs="$PWD/$lit"
  [[ -f "$abs" ]] || return 1
  CANDIDATES+=("$abs")
}

# `npm run <name>` / `npm run-script <name>`, flags in any position skipped. The
# name alone: which files that script body runs is package.json's answer, and the
# judge reads it there.
add_npm_script() {
  local word saw_run=0
  for word in "$@"; do
    [[ "$word" == -* ]] && continue
    if ((saw_run)); then
      local name
      name="$(gp_literal "$word")" || return 0 # unreadable: guess at nothing
      CANDIDATES+=("npm-script:$name")
      return 0
    fi
    [[ "$word" == "run" || "$word" == "run-script" ]] || return 0
    saw_run=1
  done
}

# One command the string runs, its own words as $2 onward.
judge() {
  shift # the flattened segment; only the words are read here
  local first="$1" base word
  base="$(gp_literal "$first")" || return 0
  base="${base##*/}"
  case "$base" in
    node | nodejs | bash | sh | zsh | python | python3 | tsx | ts-node)
      shift
      # The FIRST word that is a file, and only it: everything after it is that
      # script's own arguments, and several of them are script paths — `node
      # scripts/session-arbiter.js claim scripts/foo.js` is the contention poll
      # CLAUDE.md prescribes, and warning about its argument would fire the guard
      # on the very command sent to check a claim.
      for word in "$@"; do add_path "$word" && break; done
      ;;
    npm | pnpm)
      shift
      add_npm_script "$@"
      ;;
    *) add_path "$first" ;;
  esac
}

gp_walk_commands judge

# Nothing that looks like a script run: the overwhelming majority of Bash calls
# leave here without paying for a node start.
((${#CANDIDATES[@]})) || gp_allow

# shellcheck source=scripts/lib/guard-root.sh
source "$here/lib/guard-root.sh"
root="$(gr_root)"
# The judge ships BESIDE this guard, so it is named from `$here` and not from
# the host root (#1): a plugin install keeps the pair together, and the host
# repo has no scripts/ of the core's at all.
judge_js="$here/warn-stale-script.js"
command -v node >/dev/null 2>&1 && [[ -f "$judge_js" ]] ||
  gl_open "warn-stale-script.js could not be run — a script invocation allowed unchecked"

# Without a session id the judge cannot tell a neighbour's claim from this
# session's own, and every warning it made would be about the reader's own
# work-in-progress. Allowed unchecked, and recorded, rather than warned wrongly.
session="$(gp_payload_field '.session_id')"
[[ -n "$session" ]] ||
  gl_open "no session_id in payload — a script invocation allowed unchecked"

warning="$(node "$judge_js" "$session" "${CANDIDATES[@]}" 2>/dev/null)" ||
  gl_open "warn-stale-script.js exited non-zero — a script invocation allowed unchecked"

[[ -n "$warning" ]] && gp_warn "$warning"
gp_allow
