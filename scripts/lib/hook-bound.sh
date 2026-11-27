# shellcheck shell=sh
hb_runner="$(cd "${WFC_PLUGIN_ROOT:-$(dirname "$0")/..}" 2>/dev/null && pwd)/scripts/lib/run-budgeted.js" || hb_runner=""
if [ -n "$hb_runner" ] && [ -r "$hb_runner" ] && command -v node >/dev/null 2>&1; then
  hb_hook=${0##*/}
  exec 8>&2
  hook_bound() { command node "$hb_runner" --hook "$hb_hook" ${hb_pausable:+--pausable} "$@"; }
  node() { hook_bound node "$@"; }
  bash() { hook_bound bash "$@"; }
else
  hook_bound() { "$@"; }
fi
