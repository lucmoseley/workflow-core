#!/usr/bin/env bash
# guard-node-heap.sh — PreToolUse guard: hand a session the Node heap rule on a
# command touching `max-old-space-size`, the moment it might remove or raise
# the cap (#2025).
#
# INJECTION ONLY — it never denies. Setting a lower heap for one command is
# legitimate (the vitest wrapper sets 2048), and a raise cannot be told from
# a lowering without parsing every way NODE_OPTIONS can be built.
#
# It is narrowed to `if: Bash(*max-old-space-size*)` and
# `if: Bash(*max_old_space_size*)`, as V8 takes either spelling.
#
# IMPLICIT: on a Bash command naming the flag it injects `rule:node-heap` as
#   additionalContext and writes a `.rule-injected-*` latch under
#   .claude/tmp/markers.
# JUSTIFIED: fail-safe — it adds context and refuses nothing; the latch keeps
#   a session that sets the flag often from paying for the rule each time.
# DEFEAT: `scripts/clear-rule-latch.sh` clears the latch and it is said again;
#   deleting either registration silences that spelling.
#
# LIMITS
#  - A mixed spelling such as `max-old_space-size`, which V8 also accepts,
#    passes the `if` narrowing and is never seen.
#  - It matches the flag anywhere in the command, so a `grep` or `echo` that
#    only mentions it spends the once-a-session delivery.
#  - An edit to `~/.bashrc` through Write or Edit, or a heap set from inside a
#    script the command runs, is no Bash command naming the flag.
#  - It FAILS OPEN on anything it cannot resolve, on the record (mantahostels#147),
#    except gp_rule's store side, which exits 2 on an unreadable fragment.

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

# The `if` narrowing already matched, but a direct run or a widened wiring
# reaches here on any command.
[[ "$(gp_subject)" =~ max[-_]old[-_]space[-_]size ]] || gp_allow
gp_rule node-heap

gp_allow
