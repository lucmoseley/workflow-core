#!/usr/bin/env bash
# PostToolUse recorder on Bash: re-record what this session's claimed files hold
# now, because a shell command may have written any of them and no other hook
# sees it (mantahostels#295).
#
# Without it, a session's own version-stamp `sed -i` on a file it holds reports at
# its next write as a clobber by an unwatched route — the very class the detector
# exists to name (the measured share is in mantahostels#288).
#
# IT READS BYTES, NEVER THE COMMAND. Parsing a shell command for its write
# targets is the arms race mantahostels#287 declined. So it refreshes what the session holds,
# and scans the watched tiers (mantahostels#419), baselining whatever moved since
# this session's own last call. The scan is what covers a session that reached
# the file only from Bash and so holds no claim to refresh. It mints a baseline
# and a recovery pin, never a lock: a scan sees that bytes changed, not who
# changed them, so a claim from one would block a neighbour on an inference.
#
# It is a recorder, not a guard. Every failure path exits 0 silently.
#
# IMPLICIT:  after every Bash call, re-records the bytes of the files this session holds and baselines whatever moved under the watched tiers.
# JUSTIFIED: fail-safe — a Bash-route write mints no claim, so without this scan a clobber by `cp`, `sed -i`, a heredoc or a neighbour is reported against nobody (mantahostels#419).
# DEFEAT:    none — it reads bytes and never the command, so there is nothing to opt out of.

set -uo pipefail

done_() { exit 0; }

payload="$(cat)"
[[ -n "$payload" ]] || done_
command -v jq >/dev/null 2>&1 || done_
command -v node >/dev/null 2>&1 || done_

session="$(printf '%s' "$payload" | jq -r '.session_id // ""' 2>/dev/null)" || session=""
[[ -n "$session" ]] || session="${CLAUDE_CODE_SESSION_ID:-}"
[[ -n "$session" ]] || done_

here="$(dirname "${BASH_SOURCE[0]}")"

# Bounded: fail-open-on-exception does not catch a hang, and mkdirSync(recursive)
# under an unreadable path blocks forever on this kernel.
if command -v timeout >/dev/null 2>&1; then
  timeout 5 node "$here/session-arbiter.js" refresh "$session" >/dev/null 2>&1
else
  node "$here/session-arbiter.js" refresh "$session" >/dev/null 2>&1
fi

done_
