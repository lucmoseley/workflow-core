#!/usr/bin/env bash
# PreToolUse guard: last30days may only run inside a subagent.
#
# Why: the skill costs ~87.4k tokens on invocation. Called inline they stay in
# the working session's context, re-read on every later turn and hastening its
# compaction. Called in a subagent, the fan-out stays in the subagent's own
# context and only the findings come back.
#
# The signal is `agent_id`, which Claude Code sets on the hook payload ONLY when
# the tool call originates inside a subagent. Absent => main session => deny.
#
# LIMITS — this guards the Skill tool, and nothing else. It does not stop the
# underlying engine being run directly through Bash, and it cannot: that path is
# an ordinary command line with no distinguishing shape. Treat this as a guard
# against the accidental inline call, which is the actual failure mode, not as a
# hard capability boundary.

set -uo pipefail

# The shared library, for the payload seam and the verdict envelope only (mantahostels#138,
# mantahostels#157) — this guard judges a Skill call, not a shell command, so it needs
# neither walker. Same load gate as every other guard: `declare -F gp_begin`,
# never `source`'s own exit status, and a library it cannot read disarms the guard
# rather than blocking every Skill call
# (mantahostels#103 §6, fail open) — recorded via lib/guard-log.sh (mantahostels#147), which is sourced
# separately so that failure is loggable at all.
here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null

# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null
declare -F gp_begin >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-parse.sh did not load — every skill call allowed unchecked"
  exit 0
}

# This guard hides a fault worse than the others: a jq that is missing or that
# chokes leaves the skill name empty, the `case` below reads that as "not our
# skill", and the ~87k-token inline invocation the guard exists to stop goes
# through. gp_begin records and allows on each of those rather than letting an
# empty name fall through; an empty payload alone is not a fault, since there is
# nothing to check.
gp_begin '.tool_input.skill' "skill call"
skill="$(gp_subject)"

# A parse failure here would read as "main session" and DENY a sanctioned
# subagent call, so it fails open like the rest rather than guessing.
agent="$(gp_payload_field '.agent_id')" ||
  gl_open "could not read agent_id from payload — skill call allowed unchecked"

# Plugin skills arrive namespaced ("last30days:last30days"); match either form
# without matching some unrelated skill that merely mentions it.
case "$skill" in
  last30days | last30days:* | *:last30days) ;;
  *) exit 0 ;; # not our skill — stay out of the way
esac

# Inside a subagent: this is the sanctioned path.
[[ -n "$agent" ]] && exit 0

# The envelope is gp_deny's (mantahostels#138); the words below are this guard's.
IFS= read -r -d '' reason <<'EOF' || :
last30days must run in a subagent, not the main session: one invocation pours ~87k tokens into this session's context, where every later turn re-reads them. Re-issue it via the Agent tool (subagent_type: general-purpose) with the research question in the prompt, and instruct that agent to invoke the last30days skill and report back only its findings. The same call will be allowed there.

Give that prompt an artefact line of its own:

    Artefact: .claude/tmp/last30days-<slug>.md

and tell the agent to append findings there as they land. From a throwaway worktree hand the absolute path instead, a relative one resolving inside that worktree.
EOF
gp_deny "$reason"
