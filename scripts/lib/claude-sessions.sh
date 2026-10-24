# shellcheck shell=bash
# lib/claude-sessions.sh — wfc_session_count prints the live-session count
# docs/environment.md §5 sets: `bg-pty-host` processes matched on argv[0], less
# the daemon's unclaimed spare.
# lib/claude_sessions.py is the Python twin and says why the spare's `bg-spare`
# child is told apart by its cwd (workflow-core#1798).
#
# Usage:  ps -eo pid=,ppid=,args= | wfc_session_count [<args-column>]
#         The column argv starts in, 3 by default.
wfc_session_count() {
  local kind pid dir host n=0 gone=" "
  while read -r kind pid dir host; do
    if [[ "$kind" == host ]]; then
      n=$((n + 1))
    elif [[ "$gone" != *" $host "* && "/proc/$pid/cwd" -ef "$dir" ]]; then
      gone+="$host "
      n=$((n - 1))
    fi
  done < <(awk -v a="${1:-3}" '
    function is_claude(s,   b) {
      b = s
      sub(/.*[\/\\]/, "", b)
      return (b == "claude" || b == "claude.exe" || s ~ /\/claude\/versions\//)
    }
    !is_claude($a) { next }
    $(a + 1) == "bg-pty-host" { host[$1] = 1; print "host", $1 }
    $(a + 1) == "bg-spare" {
      for (i = a + 2; i < NF; i++)
        if ($i == "--bg-spare") {
          d = $(i + 1)
          sub(/\/[^\/]*$/, "", d)
          spare[$1] = $2 " " d
        }
    }
    END {
      for (p in spare) {
        split(spare[p], f, " ")
        if (f[1] in host) print "spare", p, f[2], f[1]
      }
    }')
  printf '%s\n' "$n"
}
