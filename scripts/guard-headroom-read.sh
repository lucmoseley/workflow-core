#!/usr/bin/env bash
# PreToolUse guard: hand a session the headroom rule BEFORE it decides that a
# short memory reading means stop (mantahostels#1933, deferred at mantahostels#1843 and re-opened when
# its condition fired).
#
# INJECTION ONLY — it never denies. Reading memory is the correct thing to do;
# what the rule corrects is the conclusion drawn from the reading, which no
# guard can observe.
#
# WHY HERE AND NOT AT THE LAUNCH. scripts/guard-suite-concurrency.sh already
# warns at a suite launch, but the failure this exists for happens EARLIER: the
# session reads `free -m`, compares it to docs/agents/guard-registry.md §Machine limits, and stops
# without ever issuing a launch, so a PreToolUse hook on the launch never fires
# (mantahostels#1930's spec review, which traced it).
#
# Cost of its `if` narrowings, `Bash(*free *)` and `Bash(*/proc/meminfo*)`
# (mantahostels#2811): a bare `free` with no flag never execs this guard, so the
# reading it takes states nothing.
#
# IMPLICIT: on an ALLOWED memory read it injects one rule as additionalContext
#   and writes a `.rule-injected-*` latch under .claude/tmp/markers.
# JUSTIFIED: fail-safe — the rule has no enforcing guard and cannot have one, a
#   hook seeing one tool call at a time and never the conclusion drawn from it.
#   The latch keeps it from costing bytes on every later read.
# DEFEAT: `scripts/clear-rule-latch.sh` clears the latch and it is said again;
#   deleting the registration from self-plugin/hooks/hooks.json silences it.
#
# LIMITS
#  - It fires on `free` and on a read of /proc/meminfo. A reading reached any
#    other way — `vmstat`, `top`, a script, `memcheck` — states nothing, only a
#    segment's own first word being read for the `free` limb.
#  - `free --help` and `free -V` report no memory, so both are filtered: the
#    latch would spend the injection the real read needed. `-h` is NOT filtered
#    — it is free's human-readable flag, not help.
#  - It FAILS OPEN on anything it cannot resolve, and the fail-open is RECORDED
#    (mantahostels#147). The exception is gp_rule's store side, which exits 2 on a fragment
#    it cannot read (mantahostels#1762).
#  - It guards the Bash tool. A reading taken outside Claude Code sees no hook.

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

# Called once per command segment. It judges nothing; it records that the
# trigger fired, and the emission happens once at the foot of the file so a
# command carrying two readings is not told twice.
judge() {
  shift
  local word="$1" arg
  shift
  case "$word" in
    free)
      for arg in "$@"; do
        # NOT -h, which is free's own human-readable flag and the spelling
        # CLAUDE.md §Machine limits tells a session to run.
        case "$arg" in
          --help | -V | --version) return 0 ;;
        esac
      done
      rule_subject=1
      ;;
    # /proc/meminfo is the same reading by another route — every reader of it
    # takes the file as an argument, whatever the command.
    *)
      for arg in "$word" "$@"; do
        [[ "$arg" == */proc/meminfo ]] && rule_subject=1
      done
      ;;
  esac
}

# Not local; see judge.
rule_subject=0

gp_walk_commands judge

((rule_subject)) || gp_allow
gp_rule headroom-reap

gp_allow
