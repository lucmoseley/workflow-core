# shellcheck shell=bash

_wfc_shell_start_warn() {
  local meminfo="${WFC_MEMINFO:-/proc/meminfo}"
  local floor_mb="${WFC_HEADROOM_FLOOR_MB:-2200}"
  local avail_kb
  avail_kb=$(awk '$1 == "MemAvailable:" { print $2; exit }' "$meminfo" 2>/dev/null)
  case "$avail_kb" in '' | *[!0-9]*) return 0 ;; esac
  local avail_mb=$((avail_kb / 1024))
  [[ "$avail_mb" -lt "$floor_mb" ]] || return 0
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
