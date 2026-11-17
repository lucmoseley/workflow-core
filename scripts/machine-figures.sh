#!/usr/bin/env bash
# machine-figures.sh — SessionStart: one line giving this machine's
# architecture, cores, total memory and total swap, read live, so a session
# reasons about the machine it runs on rather than one an instruction file
# describes (#5340). A read that fails is named as unreadable, never printed
# as 0.
#
# WFC_MEMINFO replaces /proc/meminfo with a fixture, the seam lib/proc-root.js
# names; WFC_UNAME and WFC_NPROC name the `uname` and `nproc` to run.
#
# IMPLICIT:  at every session start, prints one line of this machine's architecture, cores, MemTotal and SwapTotal into the session's context.
# JUSTIFIED: convenience — the machine rules are figure-free, so this line is where a session learns the machine it runs on (#5340).
# DEFEAT:    none — it only prints.
# TREE:      none — reads /proc/meminfo, uname and nproc, no repository.
set -uo pipefail

arch=$("${WFC_UNAME:-uname}" -m 2>/dev/null) || arch=
cores=$("${WFC_NPROC:-nproc}" 2>/dev/null) || cores=
meminfo=${WFC_MEMINFO:-/proc/meminfo}

# The named meminfo field in MiB, or empty where the file or the field is unreadable.
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
