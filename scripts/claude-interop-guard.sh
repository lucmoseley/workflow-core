# shellcheck shell=bash
_cig_here="${BASH_SOURCE[0]%/*}"
[[ "$_cig_here" == "${BASH_SOURCE[0]}" ]] && _cig_here=.
# shellcheck source=scripts/lib/interop-probe.sh
source "$_cig_here/lib/interop-probe.sh" 2>/dev/null
unset _cig_here

claude() {
  if command -v claude_interop_wedged >/dev/null 2>&1; then
    if claude_interop_wedged; then
      claude_interop_recovery_text
      return 1
    fi
  fi

  # claude-route-exempt: #3559
  command claude "$@"
}
