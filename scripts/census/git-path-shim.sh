#!/bin/sh
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
