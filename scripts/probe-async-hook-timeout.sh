#!/usr/bin/env bash
# Re-runs mantahostels#2331's measurement: does this CLI build cancel an `async` SessionStart
# hook at its configured `timeout`? On 2.1.252 it does not — the hook runs until
# the session's own process exits (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/async-hook-timeout-enforcement.md).
#
# NOT a test and never wired into one: each arm spends a real `claude -p` turn.
# Run it by hand after a CLI upgrade, or when the answer is doubted.
#
#   scripts/probe-async-hook-timeout.sh
#
# EXIT: 0 the finding still holds; 1 the build has changed and the doc is stale;
# 2 an arm did not run, which is neither — a missing `claude`, an exhausted
# allowance or a retired MODEL id all land here.
#
# A scratch project under $TMPDIR carries the wiring, so this repo's own
# .claude/settings.json is never touched. Two arms, one field apart:
#   sync  — the ceiling under test, expected to kill the hook on schedule
#   async — the same hook and ceiling with "async": true
# The async arm also wires a synchronous `sleep $HOLD` hook to hold the session
# alive well past the ceiling; without it a `claude -p` session exits in ~5 s and
# proves nothing. The sync arm needs none: a hook that blocks the start cannot
# outlive the start.
#
# BOTH ARMS DECIDE THE VERDICT. A build that cancels nothing at all — an async
# hook surviving because no ceiling is enforced anywhere — is not this finding.
set -euo pipefail

# Each tick is one second the hook survived.
CEILING=${CEILING:-5}
HOLD=${HOLD:-30}
TICKS=${TICKS:-40}
MODEL=${MODEL:-claude-haiku-4-5-20251001}
# Slack over the ceiling before a survival counts as one: enough to absorb the
# harness's own overshoot (mantahostels#2287).
SLACK=${SLACK:-8}

if [ "$TICKS" -le "$HOLD" ]; then
  echo "TICKS ($TICKS) must exceed HOLD ($HOLD), or the hook ends before the session does" >&2
  exit 2
fi

probe=$(mktemp -d "${TMPDIR:-/tmp}/async-hook-probe.XXXXXX")
trap 'rm -rf "$probe"' EXIT
mkdir -p "$probe/.claude"

cat >"$probe/tick.sh" <<EOF
#!/usr/bin/env bash
log="\$(dirname "\$0")/tick.log"
for i in \$(seq 1 $TICKS); do sleep 1; echo "TICK \$i \$(date +%s.%N)" >> "\$log"; done
echo "COMPLETED \$(date +%s.%N)" >> "\$log"
EOF
cat >"$probe/hold.sh" <<EOF
#!/usr/bin/env bash
sleep $HOLD
EOF
chmod +x "$probe/tick.sh" "$probe/hold.sh"

# $1: "true" to wire the ticking hook async, which also wires the hold hook.
# Prints the arm's tick count — the seconds the hook survived. Exits 2 if the
# session itself did not run.
run_arm() {
  local async=$1 hold="" status ticks
  [ "$async" = true ] && hold=",
          { \"type\": \"command\", \"command\": \"$probe/hold.sh\", \"timeout\": $((HOLD * 2)) }"
  rm -f "$probe/tick.log"
  cat >"$probe/.claude/settings.json" <<EOF
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "$probe/tick.sh", "timeout": $CEILING, "async": $async }$hold
        ]
      }
    ]
  }
}
EOF
  status=0
  (cd "$probe" && env -u CLAUDE_CODE_SESSION_ID -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT \
    -u CLAUDE_CODE_CHILD_SESSION timeout "$((HOLD * 5))" \
    claude -p "reply with the two letters OK and nothing else" --model "$MODEL" >/dev/null 2>&1) || status=$?
  if [ "$status" -ne 0 ]; then
    echo "the ${async}-wired arm's own \`claude -p\` exited $status — nothing was measured" >&2
    exit 2
  fi
  # grep -c prints 0 AND exits 1 on no match, so the fallback is on the
  # assignment.
  ticks=$(grep -c '^TICK' "$probe/tick.log" 2>/dev/null) || ticks=0
  echo "$ticks"
}

sync_ticks=$(run_arm false)
async_ticks=$(run_arm true)

echo "ceiling ${CEILING}s, async arm's session held alive ${HOLD}s"
echo "  synchronous: $sync_ticks tick(s) — one per second the hook survived"
echo "  async:       $async_ticks tick(s)"

if [ "$sync_ticks" -gt "$((CEILING + SLACK))" ]; then
  echo "VERDICT: this build enforces no ceiling on a SYNCHRONOUS hook either, so the"
  echo "         async arm says nothing — mantahostels#2331 compared against a control that held"
  exit 1
fi
if [ "$async_ticks" -gt "$((CEILING + SLACK))" ]; then
  echo "VERDICT: the ceiling is NOT enforced on an async hook (mantahostels#2331's finding stands)"
  exit 0
fi
echo "VERDICT: the async hook died near its ceiling — mantahostels#2331's finding no longer holds on this build"
exit 1
