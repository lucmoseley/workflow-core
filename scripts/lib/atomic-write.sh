#!/usr/bin/env bash
# atomic-write.sh — the shell scripts' one temp-file-and-rename writer (workflow-core#2251),
# the shell half of lib/atomic-write.js. rename(2) within one directory is
# atomic, so a concurrent reader sees the old file or the new one, never a torn
# write.
#
# SOURCED, NEVER RUN.
#
# The aside is `<file>.<pid>.<hex>.tmp`, as the JS half names it, created under
# noclobber so a clash refuses rather than shares an aside. A writer killed
# between the two steps leaves its aside behind. The day-old sweeps of
# lib/agent-poll-host.js and lib/echo-record-host.js collect it there, and bg-run.sh's sits
# in its run directory; design-mode.sh's and burn-mode.sh's stay beside the
# settings file, where git status shows the one in a repo.

# aw_write <file> [<command> [<arg>…]] — replace <file> with the command's
# stdout, or with stdin where no command is given. The aside takes <file>'s
# permission bits where <file> exists, the umask's where not. A fault at any
# step removes the aside, leaves <file> as it was and returns 1. A
# symlinked <file> is written at the file it resolves to, so the link survives.
aw_write() {
  local file="$1" aside rc=0
  shift
  [[ -L "$file" ]] && { file="$(readlink -f -- "$file")" || return 1; }
  aside="$file.$BASHPID.$(printf '%04x%04x' "$RANDOM" "$RANDOM").tmp"
  (set -C && : >"$aside") 2>/dev/null || return 1
  if (($#)); then "$@" >"$aside"; else cat >"$aside"; fi || rc=1
  ((rc)) || [[ ! -e "$file" ]] || chmod --reference="$file" "$aside" || rc=1
  # -T: a directory at <file> refuses the rename rather than taking the aside in.
  ((rc)) || mv -fT "$aside" "$file" || rc=1
  ((rc)) && rm -f "$aside"
  return "$rc"
}
