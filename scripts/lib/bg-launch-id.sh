# shellcheck shell=bash
# bg-launch-id.sh — the job id in what `claude --bg` printed (workflow-core#4343), held to
# the recorded launch by scripts/lib/bg-launch.contract.test.ts.
#
# SOURCED, never run.

# bg_launch_id — reads a launch's stdout on stdin and prints its job id: the
# first run of 8 hex characters, `backgrounded · <id> · <name> …` with colour
# escapes around the id; prints nothing where there is none.
bg_launch_id() {
  sed 's/\x1b\[[0-9;]*[A-Za-z]//g' | grep -oE '[0-9a-f]{8}' | head -1
}
