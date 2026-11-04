# shellcheck shell=sh
# hook-bound.sh — every checker a git hook runs, run under one wall-clock
# limit, so a checker that never returns fails its hook naming itself (#4187).
#
# SOURCED, NEVER RUN, near the top of each .husky/<hook> that starts a
# checker, and POSIX sh. `hook_bound <command> [args…]` runs the command
# through scripts/lib/run-budgeted.js --hook, which kills it and everything it
# started past the limit. Its exit is 124 or 137 then, so a pre-commit gate's
# `|| exit "$?"` refuses the commit. The limit and its derivation:
# run-budgeted.js's HOOK_LIMIT_MS.
#
# `node` and `bash` are shell functions calling hook_bound, so every `node`
# and `bash` a hook names is bounded; a binary a hook runs by any other name
# is bounded only where its line opens `hook_bound`. Not bounded: what a hook
# hands to `sh -c` — the adopter's declared check_staged, typecheck and lint
# commands. A slow gate whose run has a ceiling of its own — the declared test
# command, the mutation hold and pre-push's mod tests — is spelt `command node`
# at its call site, which skips the function.
#
# THE KILL LINE GOES TO FD 8, this hook's own stderr as it was when this file
# was sourced, so a call site discarding or capturing a checker's stderr still
# shows it.
#
# Without run-budgeted.js beside it, as in a test fixture holding part of
# scripts/, or without a `node` on PATH, hook_bound
# runs its command unbounded and `node` and `bash` stay the binaries, so a
# hook's `command -v node` still answers for the binary.
#
# DEFEAT:    WFC_HOOK_LIMIT_S raises or lowers the limit for the run that sets
#            it; HUSKY=0 skips the hooks altogether.
hb_runner="$(cd "${WFC_PLUGIN_ROOT:-$(dirname "$0")/..}" 2>/dev/null && pwd)/scripts/lib/run-budgeted.js" || hb_runner=""
if [ -n "$hb_runner" ] && [ -r "$hb_runner" ] && command -v node >/dev/null 2>&1; then
  hb_hook=${0##*/}
  exec 8>&2
  hook_bound() { command node "$hb_runner" --hook "$hb_hook" "$@"; }
  node() { hook_bound node "$@"; }
  bash() { hook_bound bash "$@"; }
else
  hook_bound() { "$@"; }
fi
