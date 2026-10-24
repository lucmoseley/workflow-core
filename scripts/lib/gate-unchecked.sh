# shellcheck shell=bash
# gate-unchecked.sh — the fail-open a session's pre-commit gate takes on its own
# faults: one stderr line, logged for check-guard-errors.js (#1699).
#
# SOURCED, NEVER RUN. Each gate sourcing it then names itself:
#
#   gate_unchecked_as <the gate, as its stderr line names it> <what its log line says went unchecked>
#
# unchecked <constant fault> [<detail>] — print, log and exit 0.
#
# Each gate carries its own copy of the fallback for this file failing to load,
# since that is the one fault this file cannot handle.

# shellcheck source=scripts/lib/guard-log.sh
source "${BASH_SOURCE[0]%/*}/guard-log.sh" 2>/dev/null
declare -F gl_log >/dev/null 2>&1 || gl_log() { :; }

unchecked_gate=""
unchecked_what=""
gate_unchecked_as() {
  unchecked_gate="$1"
  unchecked_what="$2"
}

unchecked() {
  echo "pre-commit: $unchecked_gate $1${2:+ ($2)} — this commit is NOT checked. See: node ${WFC_PLUGIN_ROOT:+$WFC_PLUGIN_ROOT/}scripts/check-guard-errors.js" >&2
  gl_log "${0##*/}: $1 — $unchecked_what" "${2-}"
  exit 0
}
