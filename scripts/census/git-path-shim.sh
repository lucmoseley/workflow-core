#!/bin/sh
# git-spawn census, instrument 1 of 2 — the PATH shim.
#
# Put a directory holding a file named exactly `git`, containing this body,
# first on PATH with SPAWNLOG exported, and every git spawn anywhere in the
# run — test-side or guard-side, in-process or a real subprocess — is logged
# before the real binary runs. Run both instruments together; see this
# directory's header comment in git-spawn-wrapper.setup.ts for the combined
# method and why one instrument alone systematically undercounts (mantahostels#2181).
# The parent chain reads the real /proc, never WFC_PROC's fake: it is the
# real git spawn's (#3608).
# -u alone: dash has no pipefail, and no -e, since a failed log write must
# still reach the exec below.
set -u
log=${SPAWNLOG:-/dev/null}
pcomm=unknown
[ -r "/proc/$PPID/comm" ] && read -r pcomm <"/proc/$PPID/comm" 2>/dev/null
chain=""
p=$PPID
i=0
while [ "$i" -lt 10 ] && [ -n "$p" ] && [ "$p" != "0" ] && [ "$p" != "1" ]; do
  chain="$chain,$p"
  [ -r "/proc/$p/stat" ] || break
  read -r line <"/proc/$p/stat" 2>/dev/null || break
  rest=${line##*") "}
  rest=${rest#* }
  p=${rest%% *}
  i=$((i + 1))
done
printf 'git\t%s\t%s\t%s\t%s\n' "$pcomm" "${chain#,}" "$(pwd -P)" "$(date +%s%3N)" >>"$log" 2>/dev/null
exec /usr/bin/git "$@"
