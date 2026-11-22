#!/usr/bin/env bash
set -uo pipefail

arch=$("${WFC_UNAME:-uname}" -m 2>/dev/null) || arch=
cores=$("${WFC_NPROC:-nproc}" 2>/dev/null) || cores=
meminfo=${WFC_MEMINFO:-/proc/meminfo}

mib() {
  awk -v f="$1:" '$1 == f && $2 ~ /^[0-9]+$/ && $3 == "kB" { printf "%d", $2 / 1024; found = 1; exit } END { exit !found }' "$meminfo" 2>/dev/null
}
mem=$(mib MemTotal) || mem=
swap=$(mib SwapTotal) || swap=

[[ $cores =~ ^[0-9]+$ ]] || cores=
unreadable=()
[[ -n "$arch" ]] || unreadable+=(architecture)
[[ -n "$cores" ]] || unreadable+=(cores)
[[ -n "$mem" ]] || unreadable+=(MemTotal)
[[ -n "$swap" ]] || unreadable+=(SwapTotal)

line="Machine (read live):"
[[ -n "$arch" ]] && line+=" $arch;"
[[ -n "$cores" ]] && line+=" $cores cores;"
[[ -n "$mem" ]] && line+=" MemTotal $mem MiB;"
[[ -n "$swap" ]] && line+=" SwapTotal $swap MiB;"
if [[ "${#unreadable[@]}" -gt 0 ]]; then
  joined=$(printf "%s, " "${unreadable[@]}")
  line+=" unreadable: ${joined%, }."
else
  line=${line%;}.
fi
printf '%s\n' "$line"
exit 0
