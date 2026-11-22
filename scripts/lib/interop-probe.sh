# shellcheck shell=bash

# measured ~10s stall, lucmoseley/mantahostels#3306
: "${CLAUDE_INTEROP_PROBE_TIMEOUT:=12}"
case "$CLAUDE_INTEROP_PROBE_TIMEOUT" in
  *[!0-9]* | "") CLAUDE_INTEROP_PROBE_TIMEOUT=12 ;;
  *) CLAUDE_INTEROP_PROBE_TIMEOUT=$((10#$CLAUDE_INTEROP_PROBE_TIMEOUT)) ;;
esac
[[ "$CLAUDE_INTEROP_PROBE_TIMEOUT" -ge 1 ]] || CLAUDE_INTEROP_PROBE_TIMEOUT=12
export CLAUDE_INTEROP_PROBE_TIMEOUT

: "${CLAUDE_INTEROP_REG:=/mnt/c/Windows/System32/reg.exe}"

_claude_interop_probe() {
  local budget="$1" reg="$CLAUDE_INTEROP_REG" rc
  # guess, lucmoseley/mantahostels#3111
  timeout -k 2 "$budget" "$reg" \
    query 'HKCU\SOFTWARE\Policies\ClaudeCode' /v Settings >/dev/null 2>&1
  rc=$?
  [[ "$rc" -ne 124 ]] && [[ "$rc" -ne 137 ]]
}

# guess, lucmoseley/mantahostels#3306
: "${CLAUDE_INTEROP_PROBE_ATTEMPTS:=3}"
case "$CLAUDE_INTEROP_PROBE_ATTEMPTS" in
  *[!0-9]* | "") CLAUDE_INTEROP_PROBE_ATTEMPTS=3 ;;
  *) CLAUDE_INTEROP_PROBE_ATTEMPTS=$((10#$CLAUDE_INTEROP_PROBE_ATTEMPTS)) ;;
esac
[[ "$CLAUDE_INTEROP_PROBE_ATTEMPTS" -ge 1 ]] || CLAUDE_INTEROP_PROBE_ATTEMPTS=3
export CLAUDE_INTEROP_PROBE_ATTEMPTS

claude_interop_wedged() {
  local reg="$CLAUDE_INTEROP_REG" i=0
  [[ -x "$reg" ]] || return 1
  command -v timeout >/dev/null 2>&1 || return 1
  while [[ "$i" -lt "$CLAUDE_INTEROP_PROBE_ATTEMPTS" ]]; do
    _claude_interop_probe "$CLAUDE_INTEROP_PROBE_TIMEOUT" && return 1
    i=$((i + 1))
  done
  return 0
}

claude_interop_recovery_text() {
  local here="${BASH_SOURCE[0]%/*}" root
  [[ "$here" == "${BASH_SOURCE[0]}" ]] && here=.
  root="$(CDPATH='' cd -P -- "$here/../.." 2>/dev/null && pwd)" || root=''
  cat >&2 <<-'EOF'

		The Windows bridge that WSL uses is stuck, so Claude would hang
		instead of starting. Not launching.

		To fix it:
		  1. Close every WSL / terminal window.
		  2. Open PowerShell and run:  wsl --shutdown
		  3. Open a terminal again and carry on.

		Session transcripts are on disk and survive. But `wsl --shutdown` is
		an abrupt kill of the VM and discards guest writes still in page
		cache, so where the machine still responds, run `sync` first.
	EOF
  printf '%s §9 has the cleanup if it does not.\n\n' "${root:+$root/}docs/environment.md" >&2
}
