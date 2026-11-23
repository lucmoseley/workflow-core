#!/usr/bin/env bash
set -euo pipefail

CEILING=${CEILING:-5}
HOLD=${HOLD:-30}
TICKS=${TICKS:-40}
MODEL=${MODEL:-claude-haiku-4-5-20251001}
SLACK=${SLACK:-8} # lucmoseley/mantahostels#2287 guess

if [[ "$TICKS" -le "$HOLD" ]]; then
  echo "TICKS ($TICKS) must exceed HOLD ($HOLD), or the hook ends before the session does" >&2
  exit 2
fi

node "$(dirname "$0")/lib/launch-auth.js" || exit 2

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

run_arm() {
  local async=$1 hold="" status ticks
  [[ "$async" = true ]] && hold=",
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
    "${WFC_CLAUDE_BIN:-claude}" -p "reply with the two letters OK and nothing else" --model "$MODEL" >/dev/null 2>&1) || status=$?
  if [[ "$status" -ne 0 ]]; then
    echo "the ${async}-wired arm's own \`claude -p\` exited $status — nothing was measured" >&2
    exit 2
  fi
  # `grep -c` prints 0 and exits 1 on no match:
  # https://www.gnu.org/software/grep/manual/grep.html#Exit-Status
  ticks=$(grep -c '^TICK' "$probe/tick.log" 2>/dev/null) || ticks=0
  echo "$ticks"
}

sync_ticks=$(run_arm false)
async_ticks=$(run_arm true)

echo "ceiling ${CEILING}s, async arm's session held alive ${HOLD}s"
echo "  synchronous: $sync_ticks tick(s) — one per second the hook survived"
echo "  async:       $async_ticks tick(s)"

if [[ "$sync_ticks" -gt "$((CEILING + SLACK))" ]]; then
  echo "VERDICT: this build enforces no ceiling on a SYNCHRONOUS hook either, so the"
  echo "         async arm says nothing — mantahostels#2331 compared against a control that held"
  exit 1
fi
if [[ "$async_ticks" -gt "$((CEILING + SLACK))" ]]; then
  echo "VERDICT: the ceiling is NOT enforced on an async hook (mantahostels#2331's finding stands)"
  exit 0
fi
echo "VERDICT: the async hook died near its ceiling — mantahostels#2331's finding no longer holds on this build"
exit 1
