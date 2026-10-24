#!/usr/bin/env bash
# PostToolUse recorder: note that THIS session wrote this file (mantahostels#114).
#
# The ledger it appends to is what scripts/concision-backstop.sh intersects its
# diff against; that file's header carries why.
#
# POST, NOT PRE. Only a tool call that returned actually wrote a file. Recording
# at PreToolUse would bill a session for a write the file-claim guard had just
# denied it — the precise second-order harm mantahostels#114 exists to remove, since acting
# on that demand means editing a file a live session holds.
#
# TOOL WRITES ONLY — a Bash-route write is credited to NOBODY, deliberately
# (ruled a silent gap at mantahostels#114, reaffirmed and measured at mantahostels#296). A write
# reaching a file by cp, mv, tee, a > redirect, sed -i, perl -i, a heredoc,
# git restore, git checkout -- <path> or a script is absent from this ledger and
# is attributed to no session at all rather than guessed at.
#
# What decides it is not the price of a parser: BOTH consumers prefer a missing
# entry to a false one, in OPPOSITE directions. A false entry makes
# concision-backstop.sh LOUDER — it bills a session for a diff it does not own,
# and the nag then sends that session to edit a file a live neighbour holds, the
# collision guard-file-claim.sh exists to refuse. A false entry makes
# guard-commit-form.sh QUIETER — a neighbour's staged path reads as the
# session's own work and the warn goes silent, and that warn is the last line
# before mantahostels#63.
#
# Measured cost of the gap (mantahostels#296, 1,579 transcripts / 789 sessions,
# 18 Jul - 15 Aug 2026): 16 sessions Bash-wrote a watched path they never
# tool-wrote and then ran a pathspec-less `git commit`, so the commit-form warn
# named their own work as foreign — capped by that warn printing its own caveat
# inline. On the concision backstop, 28 sessions had a tracked file changed only
# via Bash and 0 went un-nagged; every one was caught on its other files, so the
# miss is the pass's scope, not the pass.
#
# Crediting held paths instead adds almost nothing: 84% of Bash-write hits
# reaching a watched prefix (495 of 586) and 75% of session-path pairs (156 of
# 207) go to a path the session had already tool-written — and refresh-claims.sh refreshes only
# paths a session already holds a claim on, normally minted by that same tool
# write, so the ledger-invisible residual holds no claim to refresh. And no Bash
# parser, because completeness
# is unreachable — 46.7% of raw Bash-write hits have a destination hidden behind
# a variable, glob or command substitution.
#
# PARTLY REVERSED AT mantahostels#2778, and this file is not where it happened. The ruling
# left THIS recorder tool-only; scripts/guard-claimed-bash-write.sh, which
# already parses a Bash command's write targets AND already reads the live-claim
# store at that moment, now also appends an uncontended code target to the same
# ledger. What answered the "no Bash parser" objection above is not a better
# parser — completeness is still unreachable — but the contention filter: a path
# another live session holds is never credited, so the parser's errors can no
# longer produce the collision that made over-billing the worse direction.
#
# Its warrant is a figure the measurement above does not cover: mantahostels#296's "28
# sessions, 0 un-nagged" was the PROSE pass catching them on other files, and a
# prose catch does not fire the code-review nag. concision-backstop.sh's header
# carries what the code signal actually missed.
#
# What would invalidate this: a consumer that would rather over-attribute than
# under-attribute, or a route to attribution that does not depend on parsing a
# command line. Figures move with the corpus. DO NOT mix mantahostels#296's corpus with
# mantahostels#286's (709 transcripts, 15 Jul - 13 Aug): their watched-prefix hit counts
# differ by an order of magnitude (660 vs 47), the bulk being mutation-test
# traffic counted per target, so the two do not measure the same quantity.
#
# It is a recorder, not a guard. Every failure path exits 0 silently.

set -uo pipefail

# Silent, unlike the claim guard's log_open: this fires on every write in every
# session, so a fault would append thousands of lines to the file whose whole
# value is being short enough to read.
done_() { exit 0; }

payload="$(cat)"
[[ -n "$payload" ]] || done_
command -v jq >/dev/null 2>&1 || done_
command -v node >/dev/null 2>&1 || done_

# NotebookEdit names its target notebook_path, not file_path — reading only the
# latter is what let notebook writes past the claim guard unchecked (mantahostels#113).
file="$(printf '%s' "$payload" |
  jq -r '.tool_input.file_path // .tool_input.notebook_path // ""' 2>/dev/null)" || done_
[[ -n "$file" ]] || done_

session="$(printf '%s' "$payload" | jq -r '.session_id // ""' 2>/dev/null)" || session=""
[[ -n "$session" ]] || session="${CLAUDE_CODE_SESSION_ID:-}"
[[ -n "$session" ]] || done_

here="$(dirname "${BASH_SOURCE[0]}")"

# Bounded for the same reason the claim guard is: fail-open-on-exception does not
# catch a hang, and mkdirSync(recursive) under an unreadable path blocks forever
# on this kernel.
if command -v timeout >/dev/null 2>&1; then
  timeout 5 node "$here/session-arbiter.js" record "$file" "$session" >/dev/null 2>&1
else
  node "$here/session-arbiter.js" record "$file" "$session" >/dev/null 2>&1
fi

done_
