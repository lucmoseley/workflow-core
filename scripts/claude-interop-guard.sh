# shellcheck shell=bash
# Pre-flight guard for `claude`, sourced from ~/.bashrc.
#
# It runs the WSL interop-bridge probe before handing off to the real binary. If
# the bridge answers (or errors), launch normally and print nothing. If it
# hangs, don't launch: print the fix instead of leaving the terminal dead with
# no output. The fault, the budgets and the fail-open rule all live with the
# probe, in scripts/lib/interop-probe.sh.
#
# THIS COVERS INTERACTIVE SHELLS ONLY — it is a shell function, so a script
# calling the binary directly gets nothing from it. Such a script sources the
# probe library itself; `scripts/dispatch-sessions.sh` is the worked example.

# Its directory without a `dirname` fork, unset after: this file is sourced into
# the user's shell.
_cig_here="${BASH_SOURCE[0]%/*}"
[[ "$_cig_here" == "${BASH_SOURCE[0]}" ]] && _cig_here=.
# shellcheck source=scripts/lib/interop-probe.sh
source "$_cig_here/lib/interop-probe.sh" 2>/dev/null
unset _cig_here

claude() {
  # Fail open on a probe library that would not load: the guard may never be
  # the reason Claude won't start.
  if command -v claude_interop_wedged >/dev/null 2>&1; then
    if claude_interop_wedged; then
      claude_interop_recovery_text
      return 1
    fi
  fi

  # `command` skips this function and runs the real binary. Not `exec`: this
  # runs in the interactive shell, and exec would replace it, closing the
  # terminal when Claude exits. "$@" passes every argument through untouched,
  # so `agents`, `--resume`, `--bg`, `attach` and the rest behave as before.
  # claude-route-exempt: wraps the user's own `claude` in their interactive shell
  command claude "$@"
}
