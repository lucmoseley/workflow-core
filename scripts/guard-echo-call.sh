#!/usr/bin/env bash
# PreToolUse guard: refuse a tool call that has already answered the same thing
# twice in a row (mantahostels#2570).
#
# THE FAILURE. An ECHO TURN is a turn whose tool call is byte-identical to a
# recent one. It scales with session length — 0.5% of turns under 50, 5.0% at
# 200-399, and 24.2% of turns and 24.5% of cost past 400 (mantahostels#2562, exhaustive over
# the 3,856 sessions its own pass read).
#
# WHY guard-agent-poll.sh DOES NOT CATCH IT. That guard is wired on the same
# tools; the gap is its CLASSIFIER, which reads five named shapes. A poll spelled
# `cat`, `grep`, `tail` or a script on a background job's output file is a route
# it does not classify — its own header says so — and that spelling is where the
# mass sits, most of it a suite or job output file read by one of those verbs
# (mantahostels#2570). This guard classifies nothing. It compares.
#
# THE RULE. Refuse a call whose (tool, tool_input) signature has returned a
# byte-identical response on each of its last TWO runs. A Read's signature
# includes the file's on-disk state, so a file rewritten since is not refused
# (#1058; its residuals are ec_sig's). The harness answers a re-read of an
# unchanged file with a `type: "file_unchanged"` short circuit rather than the
# file, and record-tool-echo.sh counts that as the same answer again, so a Read
# is refused on its third call as a Bash command is. #1090 reversed
# mantahostels#2637's reset once the file-state signature made the fold measure
# no worse (`measure-echo-chain.js --read-chains`; the rows and what they cannot
# show are on #1090). lib/echo-chain.sh holds the store and the rule's
# reasoning; mantahostels#2616 holds the measured rows and their population, and
# `node scripts/measure-echo-chain.js` re-derives them. In short,
# refusing on a repeated INPUT alone is right 55.9% of the time and on two
# repeated RESPONSES 94.3%, because the legitimate repeat — a timed watch, a
# re-read after an edit — is exactly the one whose answer changes.
#
# WIRED on PreToolUse with matcher "Bash|Read", and pinned in
# scripts/hook-registrations.test.ts. ListAgents is deliberately NOT covered:
# guard-agent-poll.sh already caps it at two calls in five minutes, and on the
# measured corpus this rule split near evenly there (47 right, 35 wrong).
#
# DENY, not warn, on mantahostels#103's house rule: the call count and the response hashes
# are structured facts, and a warn cannot stop the failure because the loop's
# cost is paid per call. It sits on the deny side by a narrower margin than
# guard-agent-poll.sh, though: 5.7% of refusals on the measured corpus were
# wrong, so the reason below says how to proceed anyway.
#
# LIMITS:
#   * THE FIRST REFUSAL ON A SIGNATURE CLEARS ITS CHAIN; the second does not.
#     So a session with a real need pays one turn and carries on, and a runaway
#     loop is stopped after at most five wasted calls rather than being refused
#     every third for ever. A varied command is the way past either way.
#   * A loop whose answer changes every time — a `date`, a growing log tailed
#     with `wc -c` — is invisible here and always will be. guard-agent-poll.sh
#     is the cadence guard; this one is the repetition guard.
#   * Volatile fields in the response are dropped by NAME PATTERN
#     (lib/echo-chain.sh), so a differently-named one added upstream disarms
#     this silently.
#   * The fold keys on the harness's literal `file_unchanged` type, so a
#     renamed one upstream silently moves the Read refusal back to the fourth
#     call.
#   * It sees this agent only. A neighbour running the identical command is
#     neither seen nor counted, correctly — its cost is its own — and nor is
#     the parent or a sibling subagent under the same session (#1004).
#
# A SUBAGENT IS TOLD OTHERWISE (#1732), in guard-agent-poll.sh's words (#1169,
# #1735): where the parent is told to end the turn, a subagent is told to wait
# inside it.

set -uo pipefail

here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null

# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null
declare -F gp_begin >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-parse.sh did not load — every repeat allowed unchecked"
  exit 0
}

# shellcheck source=scripts/lib/echo-chain.sh
source "$here/lib/echo-chain.sh" 2>/dev/null
declare -F ec_sig >/dev/null 2>&1 ||
  gl_open "lib/echo-chain.sh did not load — every repeat allowed unchecked"

gp_begin '.session_id' "repeat check"

tool="$(gp_payload_field '.tool_name')"
case "$tool" in
  Bash | Read) ;;
  *) exit 0 ;;
esac

command_line="$(gp_payload_field '.tool_input.command')"
ec_skip "$tool" "$command_line" && exit 0

command -v sha1sum >/dev/null 2>&1 ||
  gl_open "sha1sum not found — every repeat allowed unchecked"

# An empty signature means the hash pipeline broke, not that there was nothing
# to judge: `.tool_input // {}` always yields an object.
sig="$(ec_sig)"
[[ -n "$sig" ]] ||
  gl_open "could not hash the call — repeat allowed unchecked"

state_file="$(ec_state_file)" ||
  gl_open "could not key the chain store — repeat allowed unchecked"
record="$(ec_lookup "$state_file" "$sig")" ||
  gl_open "could not read the chain store — repeat allowed unchecked"
[[ -n "$record" ]] || exit 0

hash="${record%%$'\t'*}"
rest="${record#*$'\t'}"
run="${rest%%$'\t'*}"
denies="${rest#*$'\t'}"
[[ "$run" =~ ^[0-9]+$ && "$denies" =~ ^[0-9]+$ ]] || exit 0
((run >= 2)) || exit 0

denies=$((denies + 1))

# ESCALATION — the first LIMITS bullet above (mantahostels#2570).
if ((denies >= 2)); then
  ec_store "$state_file" "$sig" "$hash" "$run" "$denies" ||
    gl_open "could not record the refusal — repeat allowed unchecked"
else
  # NOT `|| :` — a reset that failed leaves the chain armed, and the message
  # below promises it has been cleared. A guard failing CLOSED is what mantahostels#103 §6
  # bars. Fail open on the record instead.
  ec_store "$state_file" "$sig" "$EC_CLEARED" 0 "$denies" ||
    gl_open "could not clear the chain — repeat allowed unchecked"
fi

IFS= read -r -d '' reason <<'EOF' || :
This exact call has already run twice in a row and given the same answer both times — for a Read, the file unchanged since you last read it — so a third run is very unlikely to say anything new.

@WAITING@

If you genuinely need this again — the state it reads has changed since — VARY THE COMMAND and it will not match. The first refusal on a call clears its chain and lets the identical call through once more, but a second refusal on the same call does not, and from there only a varied command runs.
EOF

if [[ "$(gp_agent_label "told as the parent")" == main ]]; then
  waiting="If you are waiting on a background job or a subagent: END THE TURN — $(gp_parent_wait_text), so a repeat buys nothing. Say in one line what you are waiting for, then stop producing output."
else
  waiting="If you are waiting on a background job, $(gp_subagent_wait_text)"
fi

gp_deny "${reason//@WAITING@/$waiting}"
