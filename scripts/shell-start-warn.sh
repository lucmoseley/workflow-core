# shellcheck shell=bash
# Shell-start low-headroom warning, sourced from ~/.bashrc when the repo is
# present (same pattern as claude-interop-guard.sh). Repo absent: nothing is
# defined and the shell starts clean.
#
# Fires only when MemAvailable < the floor — never on session count or
# combined RSS, which stay in the message as context. The floor's
# derivation, and when to re-derive it: docs/environment.md §5.
#
# Overrides (test seam): WFC_MEMINFO, WFC_HEADROOM_FLOOR_MB, WFC_PS.

_wfc_shell_start_warn() {
  local meminfo="${WFC_MEMINFO:-/proc/meminfo}"
  local floor_mb="${WFC_HEADROOM_FLOOR_MB:-2200}"
  local avail_kb
  # The silent path costs exactly this one read.
  avail_kb=$(awk '$1 == "MemAvailable:" { print $2; exit }' "$meminfo" 2>/dev/null)
  case "$avail_kb" in '' | *[!0-9]*) return 0 ;; esac
  local avail_mb=$((avail_kb / 1024))
  [[ "$avail_mb" -lt "$floor_mb" ]] || return 0
  # Firing path only: one ps call for the diagnostic context. argv[0]
  # matching mirrors _claude_ps in ~/.bashrc — comm is the version string for
  # a backgrounded session (mantahostels#481), and a Windows argv[0] carries
  # backslashes. The session count is lib/claude-sessions.sh's, sourced in a
  # subshell so the founder's shell never gains its function.
  local ps_out sess
  ps_out=$("${WFC_PS:-ps}" -eo pid=,ppid=,rss=,args= 2>/dev/null)
  # shellcheck source=scripts/lib/claude-sessions.sh
  sess=$(source "${BASH_SOURCE[0]%/*}/lib/claude-sessions.sh" 2>/dev/null &&
    wfc_session_count 4 <<<"$ps_out")
  awk -v avail="$avail_mb" -v floor="$floor_mb" -v sess="${sess:-?}" '
		function is_claude(a,   b) {
			b = a; sub(/.*[\/\\]/, "", b)
			return (b == "claude" || b == "claude.exe" || a ~ /\/claude\/versions\//)
		}
		is_claude($4) { procs++; kb += $3 }
		END {
			printf "⚠ Low memory headroom: %d MB available, floor %d MB — near the earlyoom kill threshold. %s session(s) / %d process(es) / %.1f GB RSS (upper bound: RSS double-counts shared pages). Run memcheck.\n", \
				avail, floor, sess, procs + 0, kb / 1048576
		}' <<<"$ps_out"
}
_wfc_shell_start_warn
# Unlike the interop guard's wrapper, nothing calls this again later.
unset -f _wfc_shell_start_warn
