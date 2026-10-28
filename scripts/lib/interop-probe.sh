# shellcheck shell=bash
# The WSL interop-bridge probe, shared by every route that starts `claude`.
#
# WSL's Windows interop bridge wedges, and every `claude` launch then blocks
# forever with no output at all. The incident record, the recovery and the
# derivation of the budgets below: docs/environment.md §9.
#
# A LIBRARY RATHER THAN JUST THE GUARD (mantahostels#3111). The guard the probe was born in
# is a `claude` shell FUNCTION, so it reaches interactive shells and nothing
# else; `scripts/dispatch-sessions.sh` runs the bare binary from a script. Both
# now source this file.
#
# THREE ATTEMPTS AT A FLAT BUDGET (mantahostels#3306; the measurement is docs/environment.md §9).
#
# **Residual:** a real wedge now costs 42s to refuse rather than 19s, and a
# stall recurring on all three calls still reads as a wedge — its recurrence
# rate unmeasured, so the third attempt is a cheap margin, not a derived
# figure (mantahostels#3306).
# The bridge's vsock accept times out PER CALL at about 10s and then answers
# normally, so a 5s attempt and a 10s retry both expire inside one stall and a
# transient fault reads as a permanent wedge. A flat budget above the stall,
# tried three times, separates the two: a stall clears on attempt 2, a wedge
# expires all three.
#
# FAIL-OPEN BY DESIGN. Anything unexpected — no reg.exe, no `timeout`, a non-WSL
# machine — reads as healthy and the caller launches as normal. The probe may
# never be the reason Claude won't start.

# Seconds allowed EACH attempt before the probe is treated as a hang. Override
# for tuning:
#   CLAUDE_INTEROP_PROBE_TIMEOUT=8 claude
# A non-integer, or a zero, is reset rather than honoured — `timeout 0` never
# expires, so a wedge would hang the caller for ever.
: "${CLAUDE_INTEROP_PROBE_TIMEOUT:=12}"
case "$CLAUDE_INTEROP_PROBE_TIMEOUT" in
  *[!0-9]* | "") CLAUDE_INTEROP_PROBE_TIMEOUT=12 ;;
  *) CLAUDE_INTEROP_PROBE_TIMEOUT=$((10#$CLAUDE_INTEROP_PROBE_TIMEOUT)) ;;
esac
[[ "$CLAUDE_INTEROP_PROBE_TIMEOUT" -ge 1 ]] || CLAUDE_INTEROP_PROBE_TIMEOUT=12
export CLAUDE_INTEROP_PROBE_TIMEOUT

# The binary the probe calls. Overridable only so the wedge path can be tested
# for real, by pointing it at an executable that hangs:
#   CLAUDE_INTEROP_REG=/tmp/hangs.sh claude --version
: "${CLAUDE_INTEROP_REG:=/mnt/c/Windows/System32/reg.exe}"

_claude_interop_probe() {
  # 0 = bridge answered (or errored normally); 1 = probe timed out.
  local budget="$1" reg="$CLAUDE_INTEROP_REG" rc
  # -k sends KILL if the process ignores the TERM, so a wedged probe can't
  # itself become one of the stuck processes we're detecting. The grace is not
  # measured.
  timeout -k 2 "$budget" "$reg" \
    query 'HKCU\SOFTWARE\Policies\ClaudeCode' /v Settings >/dev/null 2>&1
  rc=$?
  # TWO CODES MEAN "BUDGET EXPIRED", NOT ONE (mantahostels#3111). 124 is the ordinary
  # expiry; 137 is 128+SIGKILL, what `-k` escalates to against a target that
  # IGNORES the TERM. Every other code, including 1 for "key does not exist"
  # (the normal case here), means the bridge is alive.
  [[ "$rc" -ne 124 ]] && [[ "$rc" -ne 137 ]]
}

# How many attempts must ALL expire before the bridge is called wedged. The 12s
# budget already absorbs the stall that was measured, so the attempts guard only
# a stall LONGER than the budget, or one recurring across calls — neither
# measured, so three is a margin and not a derived figure.
: "${CLAUDE_INTEROP_PROBE_ATTEMPTS:=3}"
case "$CLAUDE_INTEROP_PROBE_ATTEMPTS" in
  *[!0-9]* | "") CLAUDE_INTEROP_PROBE_ATTEMPTS=3 ;;
  *) CLAUDE_INTEROP_PROBE_ATTEMPTS=$((10#$CLAUDE_INTEROP_PROBE_ATTEMPTS)) ;;
esac
# ARITHMETICALLY, not on the literal `0`: `00` is all-digits and would leave the
# loop below running zero times, falling through to "wedged" with no probe made
# at all — a fail-CLOSED in a library whose header promises the opposite.
[[ "$CLAUDE_INTEROP_PROBE_ATTEMPTS" -ge 1 ]] || CLAUDE_INTEROP_PROBE_ATTEMPTS=3
export CLAUDE_INTEROP_PROBE_ATTEMPTS

# 0 = wedged, so do not launch; 1 = healthy, or the probe could not be run at
# all. Worst case is every budget PLUS every KILL grace, 3 x (12 + 2) = 42s at
# the defaults, against the 45s docs/environment.md §9 gives its caller to
# report in.
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

# What to print instead of leaving the caller dead with no output. The doc is
# named absolute, beside this file, so it resolves from any terminal and in an
# install (#1452); where the root cannot be resolved it goes out repo-relative.
# Not through script-path.sh: ~/.bashrc sources this, and that library's
# functions would land in every interactive shell.
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
