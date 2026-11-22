# shellcheck shell=bash
bg_launch_id() {
  sed 's/\x1b\[[0-9;]*[A-Za-z]//g' | grep -oE '[0-9a-f]{8}' | head -1
}
