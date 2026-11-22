# shellcheck shell=bash
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
